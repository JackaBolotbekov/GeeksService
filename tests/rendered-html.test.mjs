import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("ships Geeks Service page instead of the starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /GeeksServiceApp/);
  assert.match(layout, /Geeks Service/);
  assert.match(layout, /telegram\.org\/js\/telegram-web-app\.js/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("leaderboard cards show score instead of generic TOP badges", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/GeeksServiceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /student\.totalScore/);
  assert.doesNotMatch(app, /pointsBehindLeader === 0 \? "TOP"/);
  assert.doesNotMatch(app, /<h1>/);
  assert.doesNotMatch(app, /heroStats/);
  assert.doesNotMatch(app, /12 занятий/);
  assert.doesNotMatch(app, />ONLINE</);
  assert.doesNotMatch(app, /домашек ·/);
  assert.doesNotMatch(app, /\/12 домашек/);
  assert.match(app, /из 12 ДЗ/);
  assert.match(app, /12 из 12 ✅/);
  assert.match(app, /geeks-lightning\.svg/);
  assert.match(app, /lessonEditor/);
  assert.match(app, /addToggle/);
  assert.match(app, /inlineNameInput/);
  assert.doesNotMatch(app, /nameEditor/);
  assert.doesNotMatch(app, /Railway/);
  assert.doesNotMatch(app, /sectionTitle/);
  assert.match(css, /\.delta\s*{[^}]*background:\s*linear-gradient/s);
  assert.match(css, /\.delta\s*{[^}]*-webkit-text-stroke:\s*0 transparent/s);
  assert.match(css, /\.leaderboard\s*{[^}]*user-select:\s*none/s);
  assert.match(css, /\.lessonChip\.filled\s*{[^}]*background:\s*var\(--yellow\)/s);
  assert.match(css, /\.lessonChip\.filled\s*{[^}]*opacity:\s*1/s);
  assert.match(css, /\.lessonChip:disabled:not\(\.filled\)/);
  await access(new URL("../public/geeks-lightning.svg", import.meta.url));
  assert.doesNotMatch(app, /добавить ученика/);
});

test("includes leaderboard and admin API surfaces", async () => {
  const [leaderboardRoute, adminRoute, studentRoute, telegramRoute, importRoute, store] = await Promise.all([
    readFile(new URL("../app/api/leaderboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/[studentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/telegram/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/import-railway/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(leaderboardRoute, /listStudents/);
  assert.match(adminRoute, /createStudent/);
  assert.match(studentRoute, /updateStudent/);
  assert.match(telegramRoute, /validateTelegramInitData/);
  assert.match(importRoute, /importStudentsSnapshot/);
  assert.match(store, /SET telegram_username = \?, avatar_url = COALESCE/);
});

test("admin score picker stays in one compact row", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /grid-template-columns:\s*repeat\(11,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /\.scorePicker\s*{[^}]*repeat\(4/s);
});
