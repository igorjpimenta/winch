// definitions.test.js — definitions.js: the contract a harness reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFS } from "../../../src/tools/definitions.js";

const byName = new Map(TOOL_DEFS.map((d) => [d.name, d]));

test("the surface is exactly the eleven tools", () => {
  assert.deepEqual([...byName.keys()].sort(), [
    "backlog_append", "backlog_assign", "backlog_block", "backlog_claim", "backlog_done",
    "backlog_drop", "backlog_get", "backlog_plan", "backlog_restore", "backlog_resume", "backlog_update",
  ]);
  assert.equal(byName.size, TOOL_DEFS.length, "names are unique");
});

test("every schema is closed, documented and object-shaped", () => {
  for (const def of TOOL_DEFS) {
    assert.ok(def.description.length > 40, `${def.name} description is thin`);
    assert.equal(def.inputSchema.type, "object");
    assert.equal(def.inputSchema.additionalProperties, false);
    assert.equal(typeof def.inputSchema.properties, "object");
    for (const [key, prop] of Object.entries(def.inputSchema.properties)) {
      assert.ok(prop.description, `${def.name}.${key} has no description`);
      assert.equal(prop.$ref, undefined, `${def.name}.${key} uses $ref`);
    }
  }
});

test("ids are always described so a caller knows the prefix", () => {
  for (const name of ["backlog_get", "backlog_drop", "backlog_restore", "backlog_assign"]) {
    assert.match(byName.get(name).inputSchema.properties.id.description, /EPIC|STORY|TASK/);
  }
  assert.match(byName.get("backlog_claim").inputSchema.properties.taskId.description, /TASK/);
});

test("required fields are declared for the tools that cannot work without one", () => {
  const required = (n) => byName.get(n).inputSchema.required ?? [];
  assert.deepEqual(required("backlog_get"), ["id"]);
  assert.deepEqual(required("backlog_drop"), ["id"]);
  assert.deepEqual(required("backlog_restore"), ["id"]);
  assert.deepEqual(required("backlog_plan"), ["epic", "stories"]);
  assert.deepEqual(required("backlog_done"), ["taskId", "resultSummary"]);
  assert.deepEqual(required("backlog_claim"), [], "claim works with or without an id");
});

test("execution kinds stay inside the schema enum", () => {
  const allowed = ["pipeclaw", "subagent", "cli", "gate", "manual"];
  const planTask = byName.get("backlog_plan").inputSchema.properties.stories.items.properties.tasks.items;
  assert.deepEqual(planTask.properties.executionKind.enum, allowed);
  const appended = byName.get("backlog_append").inputSchema.properties.tasks.items;
  assert.deepEqual(appended.properties.executionKind.enum, allowed);
});
