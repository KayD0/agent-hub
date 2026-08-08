const readline = require("node:readline");

const reader = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "account/read") {
    return send({ id: message.id, result: { account: { type: "chatgpt", email: "fake@example.test" }, requiresOpenaiAuth: true } });
  }
  if (message.method === "thread/start") {
    if (message.params?.cwd?.endsWith("__timeout__")) return;
    if (message.params?.cwd?.endsWith("__crash__")) return process.exit(23);
    return send({ id: message.id, result: { thread: { id: "fake-thread" } } });
  }
  if (message.method === "thread/resume") return send({ id: message.id, result: {} });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "fake-turn" } } });
    return send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "fake-turn", status: "completed" } } });
  }
  send({ id: message.id, result: {} });
});
