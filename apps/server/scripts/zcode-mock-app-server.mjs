#!/usr/bin/env node
import readline from "node:readline";

const sessionId = "sess_mock_zcode";
const rl = readline.createInterface({ input: process.stdin });

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emit(type, payload = {}) {
  send({
    method: "session/event",
    params: { sessionId, seq: Date.now(), type, payload },
  });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.result !== undefined || message.error !== undefined) {
    return;
  }
  const { id, method, params } = message;
  if (method === "session/create" || method === "session/resume") {
    send({
      id,
      result: {
        session: {
          sessionId,
          model: { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan" },
          status: "idle",
        },
        settings: {
          mode: { current: params?.mode ?? "yolo" },
          model: {
            current: { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan" },
            available: [
              {
                label: "GLM-5.3",
                ref: { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan" },
              },
              {
                label: "GLM-5.2",
                ref: { modelId: "GLM-5.2", providerId: "builtin:zai-coding-plan" },
              },
            ],
          },
        },
      },
    });
    return;
  }
  if (
    method === "session/subscribe" ||
    method === "session/setModel" ||
    method === "session/setMode"
  ) {
    send({ id, result: { ok: true } });
    return;
  }
  if (method === "session/send") {
    send({ id, result: { accepted: true } });
    emit("turn.started", {});
    emit("model.streaming", { kind: "text_delta", delta: "hello from zcode" });
    emit("turn.completed", { resultType: "success" });
    return;
  }
  if (method === "session/stop") {
    send({ id, result: { ok: true } });
    return;
  }
  if (id !== undefined) {
    send({ id, result: {} });
  }
});
