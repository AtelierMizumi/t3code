#!/usr/bin/env node
import * as NodeReadline from "node:readline";

const sessionId = "sess_mock_zcode";
const rl = NodeReadline.createInterface({ input: process.stdin });
let currentMode = "yolo";
let currentModel = "GLM-5.3";
let nextServerRequestId = 9_000;
const pendingServerRequests = new Map();

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emit(type, payload = {}) {
  send({
    method: "session/event",
    params: { sessionId, seq: Date.now(), type, payload },
  });
}

function requestPermission({ requestId, pendingSendId, output }) {
  const resolvedRequestId = requestId ?? nextServerRequestId;
  nextServerRequestId += 1;
  pendingServerRequests.set(String(resolvedRequestId), { pendingSendId, output });
  send({
    id: resolvedRequestId,
    method: "interaction/requestPermission",
    params: {
      reason: "Mock permission request",
      toolName: "shell",
      input: { command: "echo mock" },
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject-once", kind: "reject_once" },
      ],
    },
  });
}

function completePermissionRequest(message, pending) {
  if (pending.pendingSendId !== undefined) {
    send({ id: pending.pendingSendId, result: { accepted: true } });
  }
  if (pending.output) {
    emit("model.streaming", { kind: "text_delta", delta: pending.output });
  }
  emit("turn.completed", { resultType: "success", permissionOutcome: message.result });
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
    const pending = pendingServerRequests.get(String(message.id));
    if (pending) {
      pendingServerRequests.delete(String(message.id));
      completePermissionRequest(message, pending);
    }
    return;
  }
  const { id, method, params } = message;
  if (method === "session/create" || method === "session/resume") {
    currentMode = params?.mode ?? currentMode;
    currentModel = params?.model?.modelId ?? currentModel;
    if (process.env.ZCODE_MOCK_MALFORMED_JSON === "1") {
      process.stdout.write("null\n");
    }
    send({
      id,
      result: {
        session: {
          sessionId,
          model: { modelId: currentModel, providerId: "builtin:zai-coding-plan" },
          status: "idle",
        },
        settings: {
          mode: { current: currentMode },
          model: {
            current: { modelId: currentModel, providerId: "builtin:zai-coding-plan" },
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
  if (method === "session/subscribe") {
    send({ id, result: { ok: true } });
    return;
  }
  if (method === "session/setModel") {
    if (params?.model?.modelId === "GLM-BROKEN") {
      send({ id, error: { code: -32_000, message: "mock model switch failed" } });
      return;
    }
    currentModel = params?.model?.modelId ?? currentModel;
    send({ id, result: { ok: true } });
    return;
  }
  if (method === "session/setMode") {
    currentMode = params?.mode ?? currentMode;
    send({ id, result: { ok: true } });
    return;
  }
  if (method === "session/send") {
    if (params?.content === "__fail_send__") {
      send({ id, error: { code: -32_000, message: "mock send failed" } });
      return;
    }
    if (params?.content === "__permission_collision__") {
      emit("turn.started", {});
      requestPermission({ requestId: id, pendingSendId: id, output: "collision resolved" });
      return;
    }
    send({ id, result: { accepted: true } });
    emit("turn.started", {});
    if (params?.content === "__permission__") {
      requestPermission({});
      return;
    }
    if (process.env.ZCODE_MOCK_TEXTGEN_REQUEST_PERMISSION === "1") {
      requestPermission({ output: '{"title":"ZCode title"}' });
      return;
    }
    if (process.env.ZCODE_MOCK_TURN_FAILED === "1") {
      emit("model.streaming", { kind: "text_delta", delta: '{"title":"misleading"}' });
      emit("turn.failed", { error: { message: "mock generation failed" } });
      return;
    }
    emit("model.streaming", {
      kind: "text_delta",
      delta: params?.content === "__echo_mode__" ? `mode:${currentMode}` : "hello from zcode",
    });
    emit("turn.completed", { resultType: "success" });
    return;
  }
  if (method === "session/stop") {
    emit("turn.terminal", { resultType: "cancelled" });
    send({ id, result: { ok: true } });
    return;
  }
  if (id !== undefined) {
    send({ id, result: {} });
  }
});
