const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8000");

ws.onopen = () => {
  console.log("Connected to server");
  ws.send("Hello server!");
};

ws.onmessage = (event) => {
  console.log("Received:", event.data);
};