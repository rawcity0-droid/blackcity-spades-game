# Spades live status (Oct 16, 2026)
Status: NOT PUBLIC. Server runs locally; no tunnel could be established.
Server: npm start (no DEV_UNLOCK), PID 1848898 (npm wrapper), listening 0.0.0.0:3000, local curl 200. Log: server.log
Client ws URL uses location.host -> will work through any HTTPS proxy/tunnel with no code change.
Blocked: the box only allows outbound HTTP(S) via a proxy (198.18.0.1). Tried:
- cloudflared quick tunnel: URL issued but edge connection (port 7844 QUIC/HTTP2) blocked -> HTTP 530
- localtunnel: URL issued but its data ports (e.g. 28703) blocked -> HTTP 502
- ssh tunnels (pinggy/serveo on 443, localhost.run on 22): blocked
cloudflared binary at ~/bin/cloudflared; openssh-client installed.
