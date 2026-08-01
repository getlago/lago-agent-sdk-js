#!/usr/bin/env node
import { start } from "../dist/main.js";

start().catch((err) => {
  console.error("gateway failed to start:", err?.message ?? err);
  process.exit(1);
});
