import test from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_ACTIONS,
  PERMISSION_LEVELS,
  resolveEffectivePermissions,
  validatePermissions
} from "../src/permission/permissions.js";

const readOnly = { read: "allow", edit: "deny", write: "deny" };
const writable = { read: "allow", edit: "allow", write: "allow" };

test("語彙はread/edit/writeとallow/denyに固定される", () => {
  assert.deepEqual(PERMISSION_ACTIONS, ["read", "edit", "write"]);
  assert.deepEqual(PERMISSION_LEVELS, ["allow", "deny"]);
});

test("有効なPermission宣言を受け入れる", () => {
  assert.deepEqual(validatePermissions(readOnly), []);
  assert.deepEqual(validatePermissions(writable), []);
});

test("欠落キー・未知キー・不正値を拒否する", () => {
  assert.deepEqual(validatePermissions({ read: "allow", edit: "deny" }), [
    'permissions["write"] must be either "allow" or "deny".'
  ]);
  assert.deepEqual(
    validatePermissions({ read: "allow", edit: "deny", write: "deny", execute: "allow" }),
    ['permissions has unknown key "execute".']
  );
  assert.deepEqual(
    validatePermissions({ read: "maybe", edit: "deny", write: "deny" }),
    ['permissions["read"] must be either "allow" or "deny".']
  );
});

test("オブジェクトでない宣言を拒否する", () => {
  assert.deepEqual(validatePermissions("readonly"), ["permissions must be an object."]);
  assert.deepEqual(validatePermissions(undefined), ["permissions must be an object."]);
});

test("readonly割当は役割が許す書込をdenyに強制する", () => {
  const effective = resolveEffectivePermissions(writable, "readonly");

  assert.deepEqual(effective, { read: "allow", edit: "deny", write: "deny" });
});

test("write割当は役割の宣言をそのまま使う", () => {
  assert.deepEqual(resolveEffectivePermissions(writable, "write"), writable);
});

test("役割がdenyしたPermissionはwrite割当でも緩められない", () => {
  const effective = resolveEffectivePermissions(readOnly, "write");

  assert.deepEqual(effective, { read: "allow", edit: "deny", write: "deny" });
});

test("mode未指定は役割の宣言をそのまま使う", () => {
  assert.deepEqual(resolveEffectivePermissions(readOnly, undefined), readOnly);
});
