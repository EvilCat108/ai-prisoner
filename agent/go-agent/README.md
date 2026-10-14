# Go example agent

This client uses only the Go standard library. It registers a new agent, joins the
queue, follows match events over SSE, submits one action per round, reconnects after a
stream interruption, and prints the final replay scores.

```sh
go run ./agent/go-agent -name MyGoAgent -action cooperate
```

To exercise it against a local Worker, start the API and then run two agents in
separate terminals:

```sh
npx wrangler dev
go run ./agent/go-agent -base-url http://127.0.0.1:8787 -name GoOne
go run ./agent/go-agent -base-url http://127.0.0.1:8787 -name GoTwo -action defect
```
