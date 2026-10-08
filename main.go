package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed web/*
var files embed.FS

type event struct {
	Type      string `json:"type"`
	ID        int64  `json:"id,omitempty"`
	Actor     string `json:"actor,omitempty"`
	Body      string `json:"body,omitempty"`
	LSN       string `json:"lsn,omitempty"`
	Error     string `json:"error,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	Stats     *stats `json:"stats,omitempty"`
}
type client struct {
	conn *websocket.Conn
	send chan event
}

type activityPoint struct {
	Timestamp       string  `json:"timestamp"`
	EventsPerSecond float64 `json:"eventsPerSecond"`
}
type stats struct {
	Status          string          `json:"status"`
	EventsPerSecond float64         `json:"eventsPerSecond"`
	ReplicationLag  *int64          `json:"replicationLag"`
	TotalEvents     uint64          `json:"totalEvents"`
	LSN             string          `json:"lsn"`
	Timestamp       string          `json:"timestamp"`
	Recent          []event         `json:"recent"`
	Activity        []activityPoint `json:"activity"`
}

// The same lock orders snapshots, decoded events, and client registration.
var live = stats{Status: "reconnecting", Recent: make([]event, 0, 50), Activity: make([]activityPoint, 0, 60)}
var intervalEvents uint64

var clients = map[*client]bool{}
var clientsMu sync.Mutex
var changes = regexp.MustCompile(`(?s)^table public\.messages: (INSERT|UPDATE|DELETE): (?:old-key: id\[bigint\]:\d+ actor\[text\]:'(?:[^']|'')*' body\[text\]:'(?:[^']|'')*' new-tuple: )?id\[bigint\]:(\d+) actor\[text\]:'((?:[^']|'')*)' body\[text\]:'((?:[^']|'')*)'$`)

// Caller holds clientsMu. A slow browser reconnects for a fresh snapshot.
func broadcast(e event) {
	for c := range clients {
		select {
		case c.send <- e:
		default:
			c.conn.Close()
		}
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(ctx, `CREATE TABLE IF NOT EXISTS messages (id bigserial PRIMARY KEY, actor text NOT NULL, body text NOT NULL); ALTER TABLE messages REPLICA IDENTITY FULL;`)
	if err != nil {
		log.Fatal(err)
	}
	var exists bool
	if err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='listen_to_the_wal')`).Scan(&exists); err != nil {
		log.Fatal(err)
	}
	if !exists {
		if _, err = db.Exec(ctx, `SELECT pg_create_logical_replication_slot('listen_to_the_wal', 'test_decoding')`); err != nil {
			log.Fatal(err)
		}
	}
	// Discard changes from before this process: this is a live stream, not history.
	if _, err = db.Exec(ctx, `SELECT pg_logical_slot_get_changes('listen_to_the_wal', NULL, NULL)`); err != nil {
		log.Fatal(err)
	}
	go readWAL(ctx, db)
	go broadcastStats(ctx)
	go background(ctx, db)
	root, _ := fs.Sub(files, "web")
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(root)))
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { serveSocket(ctx, db, w, r) })
	server := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		clientsMu.Lock()
		for c := range clients {
			c.conn.Close()
		}
		clientsMu.Unlock()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Println("Listen to the WAL: http://localhost:8080")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// Copy the bounded slices before queuing a snapshot for asynchronous writers.
// Caller holds clientsMu.
func snapshot() event {
	copyStats := live
	copyStats.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	copyStats.Recent = append([]event{}, live.Recent...)
	copyStats.Activity = append([]activityPoint{}, live.Activity...)
	return event{Type: "stats", Stats: &copyStats}
}

func broadcastStats(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			clientsMu.Lock()
			live.EventsPerSecond = float64(intervalEvents) / now.Sub(last).Seconds()
			intervalEvents = 0
			last = now
			// Keep at most 60 samples and discard samples older than one minute.
			for len(live.Activity) > 0 {
				at, _ := time.Parse(time.RFC3339Nano, live.Activity[0].Timestamp)
				if len(live.Activity) < 60 && at.After(now.Add(-time.Minute)) {
					break
				}
				live.Activity = live.Activity[1:]
			}
			live.Activity = append(live.Activity, activityPoint{Timestamp: now.UTC().Format(time.RFC3339Nano), EventsPerSecond: live.EventsPerSecond})
			broadcast(snapshot())
			clientsMu.Unlock()
		}
	}
}

func readWAL(ctx context.Context, db *pgxpool.Pool) {
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		clientsMu.Lock()
		if live.Status != "connected" {
			live.Status = "reconnecting"
		}
		clientsMu.Unlock()
		queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := consumeWAL(queryCtx, db)
		cancel()
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		log.Printf("WAL disconnected, retrying: %v", err)
		clientsMu.Lock()
		live.Status = "disconnected"
		live.ReplicationLag = nil
		clientsMu.Unlock()
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func consumeWAL(ctx context.Context, db *pgxpool.Pool) error {
	rows, err := db.Query(ctx, `SELECT lsn::text, data FROM pg_logical_slot_get_changes('listen_to_the_wal', NULL, 500, 'include-xids', '0', 'skip-empty-xacts', '1')`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var lsn, data string
		if err := rows.Scan(&lsn, &data); err != nil {
			rows.Close()
			return err
		}
		clientsMu.Lock()
		live.LSN = lsn
		m := changes.FindStringSubmatch(data)
		if m != nil {
			var id int64
			fmt.Sscan(m[2], &id)
			e := event{Type: strings.ToLower(m[1]), ID: id, Actor: strings.ReplaceAll(m[3], "''", "'"), Body: strings.ReplaceAll(m[4], "''", "'"), LSN: lsn, Timestamp: time.Now().UTC().Format(time.RFC3339Nano)}
			live.TotalEvents++
			intervalEvents++
			if len(live.Recent) == 50 {
				copy(live.Recent, live.Recent[1:])
				live.Recent = live.Recent[:49]
			}
			live.Recent = append(live.Recent, e)
			broadcast(e)
		}
		clientsMu.Unlock()
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// confirmed_flush_lsn is the slot's actual consumed position, including
	// transaction records and idle progress, not just the last messages row.
	var lsn string
	var lag int64
	err = db.QueryRow(ctx, `SELECT confirmed_flush_lsn::text,
  GREATEST(0, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn))::bigint
  FROM pg_replication_slots WHERE slot_name='listen_to_the_wal'`).Scan(&lsn, &lag)
	clientsMu.Lock()
	live.Status = "connected"
	live.ReplicationLag = nil
	if err == nil {
		live.LSN = lsn
		live.ReplicationLag = &lag
	}
	clientsMu.Unlock()
	// A missing lag measurement must not stop the event stream.
	return nil
}

func serveSocket(ctx context.Context, db *pgxpool.Pool, w http.ResponseWriter, r *http.Request) {
	// The cookie survives reconnects; clients cannot choose an actor in a command.
	actor := ""
	if cookie, err := r.Cookie("wal_listener"); err == nil {
		if b, err := hex.DecodeString(cookie.Value); err == nil && len(b) == 16 {
			actor = cookie.Value
		}
	}
	headers := http.Header{}
	if actor == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			http.Error(w, "No identity available", 500)
			return
		}
		actor = hex.EncodeToString(b)
		headers.Add("Set-Cookie", (&http.Cookie{Name: "wal_listener", Value: actor, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil, MaxAge: 31536000}).String())
	}
	upgrader := websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 1024}
	conn, err := upgrader.Upgrade(w, r, headers)
	if err != nil {
		return
	}
	c := &client{conn: conn, send: make(chan event, 128)}
	c.send <- event{Type: "hello", Actor: actor}
	clientsMu.Lock()
	c.send <- snapshot()
	clients[c] = true
	clientsMu.Unlock()
	done := make(chan struct{})
	defer func() { clientsMu.Lock(); delete(clients, c); clientsMu.Unlock(); close(done); conn.Close() }()
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case e := <-c.send:
				conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := conn.WriteJSON(e); err != nil {
					conn.Close()
					return
				}
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					conn.Close()
					return
				}
			}
		}
	}()
	conn.SetReadLimit(2048)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	last := time.Time{}
	for {
		var command struct {
			Type string `json:"type"`
			Body string `json:"body"`
		}
		if err := conn.ReadJSON(&command); err != nil {
			return
		}
		var err error
		if time.Since(last) < 700*time.Millisecond {
			err = errors.New("Give Postgres a beat. Try again in a second.")
		} else {
			last = time.Now()
			queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			switch command.Type {
			case "insert":
				body := strings.TrimSpace(command.Body)
				if body == "" || !utf8.ValidString(body) || utf8.RuneCountInString(body) > 160 || strings.ContainsRune(body, 0) {
					err = errors.New("Write between 1 and 160 characters.")
				} else {
					_, err = db.Exec(queryCtx, `INSERT INTO messages(actor,body) VALUES($1,$2)`, actor, body)
				}
			case "delete":
				err = deleteMessage(queryCtx, db, actor)
			default:
				err = errors.New("Unknown action.")
			}
			cancel()
		}
		if err != nil {
			if !strings.HasPrefix(err.Error(), "Give") && !strings.HasPrefix(err.Error(), "Write") && !strings.HasPrefix(err.Error(), "There") && err.Error() != "Unknown action." {
				log.Printf("command: %v", err)
				err = errors.New("Postgres couldn't commit that. Please try again.")
			}
			select {
			case c.send <- event{Type: "error", Error: err.Error()}:
			default:
				return
			}
		}
	}
}

func deleteMessage(ctx context.Context, db *pgxpool.Pool, actor string) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	err = tx.QueryRow(ctx, `SELECT id FROM messages ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("There are no messages to delete yet.")
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET actor=$1 WHERE id=$2`, actor, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM messages WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func background(ctx context.Context, db *pgxpool.Pool) {
	lines := []string{"A little noise in the database.", "Every commit leaves a rhythm.", "Put another message in the WAL.", "The rows are temporary. The beat goes on.", "Somewhere, a transaction just became a sound.", "We all share the same Postgres."}
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	for i := 0; ; i++ {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if i%3 == 2 {
			if err := deleteMessage(queryCtx, db, "house"); err != nil && !strings.HasPrefix(err.Error(), "There") {
				log.Printf("house delete: %v", err)
			}
		} else {
			if _, err := db.Exec(queryCtx, `INSERT INTO messages(actor,body) VALUES('house',$1)`, lines[(i-i/3)%len(lines)]); err != nil {
				log.Printf("house insert: %v", err)
			}
		}
		// Keep the shared playground bounded, including during long unattended runs.
		var count int
		if err := db.QueryRow(queryCtx, `SELECT count(*) FROM messages`).Scan(&count); err == nil {
			for n := 200; n < count; n++ {
				if err := deleteMessage(queryCtx, db, "house"); err != nil {
					break
				}
			}
		}
		cancel()
	}
}
