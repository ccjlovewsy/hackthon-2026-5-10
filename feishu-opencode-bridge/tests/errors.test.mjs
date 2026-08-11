import test from "node:test";
import assert from "node:assert/strict";
import { formatErr } from "../src/errors.mjs";

test("formatErr: lark SDK 风格 {code, msg}", () => {
  assert.equal(formatErr({ code: 230001, msg: "chat not found" }), "[230001] chat not found");
});

test("formatErr: 普通 Error", () => {
  assert.equal(formatErr(new Error("boom")), "boom");
});

test("formatErr: 字符串", () => {
  assert.equal(formatErr("plain string"), "plain string");
});

test("formatErr: null/undefined", () => {
  assert.equal(formatErr(null), "null");
  assert.equal(formatErr(undefined), "undefined");
});

test("formatErr: 嵌套 cause 链", () => {
  const err = new Error("outer", { cause: new Error("inner") });
  assert.equal(formatErr(err), "outer (caused by: inner)");
});
