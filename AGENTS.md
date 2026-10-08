We are buidling "Listen to the WAL"

It's about exposing a postgres servers WAL to browsers

From user perspective:

- They enter website
- Instructions on what this is (listen to postgres WAL)
- Each postgres event in the WAL gets a sound
- We go through the sounds possible in a very small tutorial
- Then we expose them to the real environment
- They can click insert message, and it gives them a textbox
- They can click delete message, delete something
- The request is sent to the server. Server takes it, gives it to postgres
- Postgres commits, and the server reads the WAL.
- Parses the WAL, figures out what user send the message, and explicitly labels that one
- The messages from the WAL come back to the user in the browser
- Imagine them floating from right to left
- They are ephemeral, its just the WAL
- It's always real time, every user is interacting with the exact same postgres instance
- They can see everyone's message always

From server perspective:

- Golang backend
- Websockets browser <=> backend
- Simple vanilla html / js frontend
- golang talks to the postgres
- postgres runs as normal, it only has one table, messages
- it all runs in docker
- have a loop that creates some WAL data so users can see something
- just loop lyrics of "another brick in the wall" by pink floyd, but all wall => WAL

some campy tag lines so you understand the vibe: "If you heard it, postgres comitted it"

do not write tests
do not run go test
do not use git
do not use a browser at any time
ask the developer for visual confirmation if needed
do not run docker compose
do not modify README

be grug. complexity bad. prefer stupid. duplicated code is ok. do not write abstractions
