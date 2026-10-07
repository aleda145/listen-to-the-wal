FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /wal .

FROM alpine:3.21
RUN adduser -D wal
USER wal
COPY --from=build /wal /wal
EXPOSE 8080
ENTRYPOINT ["/wal"]
