"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const { createFeatureRoutes } = require("../../src/features/feature-routes");
const { createApplication } = require("../../src/http/application");
const { createRoomService } = require("../../src/room");
const { createMediaBroker } = require("../../src/media");
const { createMediaRoutes } = require("../../src/media/routes");

test.describe("nine-player browser game", () => {
  let application;
  let rooms;
  let baseUrl;
  let now;

  test.beforeAll(async () => {
    now = Date.now();
    let id = 0;
    let token = 0;
    rooms = createRoomService({
      clock: () => now,
      randomInt: () => 0,
      createId: (kind) => `${kind}-e2e-${++id}`,
      createToken: () => `e2e-seat-token-${String(++token).padStart(4, "0")}`,
      durations: {
        ROLE_REVEAL: 1_000,
        NIGHT_WOLF: 1_000,
        NIGHT_WITCH: 1_000,
        NIGHT_SEER: 1_000,
        DAWN_RESOLUTION: 0,
        DAY_SPEECH: 1_000,
        DAY_VOTE: 1_000,
        LAST_WORD: 1_000,
        HUNTER_SHOT: 1_000,
      },
    });
    const gateway = {
      status: () => ({
        provider: "Lingxi API",
        configured: true,
        implemented: { transcription: true, speech: true, realtime: false },
        checked: { transcription: true, speech: true, realtime: false },
        healthy: { transcription: true, speech: true, realtime: null },
      }),
      transcribe: async () => ({ text: "E2E fake transcription" }),
      synthesize: async () => ({ audio: Buffer.from("not-real-audio"), contentType: "audio/mpeg" }),
    };
    const features = createFeatureRoutes({ rooms, gateway, clock: () => now });
    const media = createMediaRoutes({ broker: createMediaBroker({ getSnapshot: rooms.getSnapshot, clock: () => now }) });
    application = createApplication({
      rooms,
      clock: () => now,
      extension: async (context) => await features(context) || await media(context),
      host: "127.0.0.1",
      pollInterval: 100_000,
      root: path.resolve(__dirname, "../.."),
    });
    await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  });

  test.afterAll(async () => {
    await application?.stop();
  });

  test("creates, plays, reconnects, protects secrets, and renders responsively", async ({ browser }) => {
    test.setTimeout(180_000);
    const contexts = [];
    const pages = [];
    const pageErrors = [];
    const externalRequests = [];
    const coverage = [];
    const artifactDir = path.resolve(__dirname, "../../artifacts/browser");
    await fs.mkdir(artifactDir, { recursive: true });

    for (let index = 0; index < 9; index += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === baseUrl) await route.continue();
        else {
          externalRequests.push(url.href);
          await route.abort();
        }
      });
      if (index === 0) {
        await context.addInitScript(() => {
          window.__playFallbacks = 0;
          HTMLMediaElement.prototype.play = function rejectPlayback() {
            window.__playFallbacks += 1;
            return Promise.reject(new DOMException("Playback denied by E2E", "NotAllowedError"));
          };
          Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
            configurable: true,
            value: () => Promise.reject(new DOMException("Permission denied by E2E", "NotAllowedError")),
          });
        });
      }
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => pageErrors.push({ index, message: error.message }));
      if (index === 0) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".entry-screen")).toBeVisible();
    }

    const host = pages[0];
    await host.locator("#createNickname").fill("玩家1");
    await host.locator('[data-form="create-room"]').getByRole("button", { name: "创建" }).click();
    await expect(host.locator(".lobby-screen")).toBeVisible();
    const roomId = (await host.locator(".code-copy").textContent()).trim();
    expect(roomId).toMatch(/^room-e2e-/);

    for (let index = 1; index < pages.length; index += 1) {
      const page = pages[index];
      await page.locator("#roomCode").fill(roomId);
      await page.locator("#joinNickname").fill(`玩家${index + 1}`);
      await page.locator('[data-form="join-room"]').getByRole("button", { name: "加入" }).click();
      await expect(page.locator(".lobby-screen")).toBeVisible();
    }
    await expect(host.locator(".room-heading .eyebrow")).toContainText("9/9 人");

    await host.locator("#rulesButton").focus();
    await host.keyboard.press("Enter");
    await expect(host.locator("#rulesDialog")).toBeVisible();
    await host.keyboard.press("Escape");
    await expect(host.locator("#rulesDialog")).not.toBeVisible();

    for (const page of pages) {
      await page.locator('[data-command="toggle-ready"]').click();
      await expect(page.locator('[data-command="toggle-ready"]')).toContainText("取消准备");
    }
    await expect(host.locator('[data-command="start-game"]')).toBeEnabled();
    await host.locator('[data-command="start-game"]').click();
    for (const page of pages) await expect(page.locator(".role-card h2")).toBeVisible();

    const expectedRoles = ["狼人", "狼人", "预言家", "女巫", "猎人", "平民", "平民", "平民", "狼人"];
    for (let index = 0; index < pages.length; index += 1) {
      await expect(pages[index].locator(".role-card h2")).toHaveText(expectedRoles[index]);
    }

    const roleBeforeReload = await pages[1].locator(".role-card h2").textContent();
    await pages[1].reload({ waitUntil: "domcontentloaded" });
    await expect(pages[1].locator(".role-card h2")).toHaveText(roleBeforeReload);
    await expect(pages[1].locator(".room-code")).toHaveText(roomId);

    const privateFrame = await pages[5].evaluate(async () => {
      const session = JSON.parse(sessionStorage.getItem("wuyin.session.v1"));
      const response = await fetch(`/api/rooms/${session.roomId}/snapshot`, { headers: { Authorization: `Bearer ${session.seatToken}` } });
      return response.json();
    });
    expect(privateFrame.game.self.role).toBe("VILLAGER");
    expect(privateFrame.game.revealedRoles).toBeUndefined();
    expect(privateFrame.game.wolfTeammates).toBeUndefined();
    const privateJson = JSON.stringify(privateFrame);
    expect(privateJson).not.toContain('"seq"');
    expect(privateJson).not.toContain("eventId");
    expect(privateJson).not.toContain("ROLE_ASSIGNED");
    for (const secretRole of ["WEREWOLF", "SEER", "WITCH", "HUNTER"]) expect(privateJson).not.toContain(secretRole);

    const publicSnapshot = () => rooms.getSnapshot({ roomId });
    const advanceDeadline = async (phase) => {
      const before = publicSnapshot();
      expect(before.game.phase).toBe(phase);
      now = Date.parse(before.game.deadlineAt);
      application.poll();
      await expect(host.locator("#phaseTitle")).not.toHaveText(phaseLabel(phase));
      return publicSnapshot();
    };
    const waitPhase = async (phase) => {
      await expect(host.locator("#phaseTitle")).toHaveText(phaseLabel(phase));
      expect(publicSnapshot().game.phase).toBe(phase);
    };

    await advanceDeadline("ROLE_REVEAL");
    await waitPhase("NIGHT_WOLF");
    await uiTargetAction(pages[0], "seat-6", "WOLF_TARGET_SET");
    await expect(pages[0].locator(".action-console")).toContainText("服务端已记录");
    await uiTargetAction(pages[1], "seat-6", "WOLF_TARGET_SET");
    await advanceDeadline("NIGHT_WOLF");
    await waitPhase("NIGHT_WITCH");
    await clickActionResponse(pages[3], pages[3].locator('[data-command="witch-action"][data-kind="SAVE"]'));
    await advanceDeadline("NIGHT_WITCH");
    await waitPhase("NIGHT_SEER");
    await uiTargetAction(pages[2], "seat-1", "SEER_TARGET_SET");
    await advanceDeadline("NIGHT_SEER");
    await waitPhase("DAY_SPEECH");
    expect(publicSnapshot().game.deaths).toEqual([]);

    await expect.poll(() => pages[0].evaluate(() => window.__playFallbacks)).toBeGreaterThan(0);
    await pages[0].getByRole("button", { name: "录音" }).click();
    await expect(pages[0].locator("#alertRegion")).toContainText("Permission denied by E2E");
    expect(publicSnapshot().game.phase).toBe("DAY_SPEECH");
    await pages[0].getByRole("button", { name: "开启实时" }).click();
    await expect(pages[0].locator('.latency [role="status"]')).toContainText("Permission denied by E2E");
    await expect(pages[0].locator('.latency [role="status"]')).not.toContainText("实时原声已连接");
    await pages[0].setViewportSize({ width: 390, height: 844 });
    await expect(pages[0].locator('.latency [role="status"]')).toBeVisible();
    expect(await hasHorizontalOverflow(pages[0])).toBe(false);
    await pages[0].setViewportSize({ width: 1440, height: 1000 });
    await pages[0].getByRole("button", { name: "关闭实时" }).click();

    now = Date.parse(publicSnapshot().game.deadlineAt);
    application.poll();
    await expect(pages[1].locator(".action-console")).toContainText("你的发言时间");
    await pages[1].getByRole("button", { name: "录音" }).click();
    await expect(pages[1].getByRole("button", { name: "停止" })).toBeVisible();
    await pages[1].waitForTimeout(300);
    await Promise.all([
      pages[1].waitForResponse((response) => response.url().includes(`/api/rooms/${roomId}/voice`) && response.request().method() === "POST"),
      pages[1].getByRole("button", { name: "停止" }).click(),
    ]);
    await expect(pages[1].locator(".voice-list li")).toHaveCount(1);

    now = Date.parse(publicSnapshot().game.deadlineAt);
    application.poll();
    await expect(pages[2].locator(".action-console")).toContainText("你的发言时间");
    await expect(pages[2].locator('[data-command="play-voice"]')).toBeVisible();
    await pages[2].locator('[data-command="play-voice"]').click();
    await expect(pages[2].locator(".voice-list")).toContainText("哈希一致");

    expect(await hasHorizontalOverflow(pages[0])).toBe(false);
    await pages[8].setViewportSize({ width: 390, height: 844 });
    await expect(pages[8].locator(".game-shell")).toBeVisible();
    expect(await hasHorizontalOverflow(pages[8])).toBe(false);
    const desktopScreenshot = path.join(artifactDir, "game-desktop.png");
    const mobileScreenshot = path.join(artifactDir, "game-mobile-390x844.png");
    await pages[0].screenshot({ path: desktopScreenshot, fullPage: true });
    await pages[8].screenshot({ path: mobileScreenshot, fullPage: true });

    const finishSpeechByClock = async () => {
      while (publicSnapshot().game.phase === "DAY_SPEECH") {
        const before = publicSnapshot();
        now = Date.parse(before.game.deadlineAt);
        application.poll();
      }
      await waitPhase("DAY_VOTE");
    };
    const voteOut = async (targetSeatId, actionPrefix) => {
      await finishSpeechByClock();
      for (const voterIndex of [2, 3, 4]) await uiTargetAction(pages[voterIndex], targetSeatId, "VOTE_CAST", `${actionPrefix}-${voterIndex}`);
      const before = publicSnapshot();
      now = Date.parse(before.game.deadlineAt);
      application.poll();
      await waitPhase("LAST_WORD");
      const targetIndex = Number(targetSeatId.slice(5)) - 1;
      await clickActionResponse(pages[targetIndex], pages[targetIndex].locator('[data-command="submit-action"][data-type="LAST_WORD_FINISH"]'));
    };
    const advanceEmptyNight = async (useWitchSkip = false) => {
      await waitPhase("NIGHT_WOLF");
      await advanceDeadline("NIGHT_WOLF");
      await waitPhase("NIGHT_WITCH");
      if (useWitchSkip) await clickActionResponse(pages[3], pages[3].locator('[data-command="witch-action"][data-kind="SKIP"]'));
      await advanceDeadline("NIGHT_WITCH");
      await waitPhase("NIGHT_SEER");
      await advanceDeadline("NIGHT_SEER");
      await waitPhase("DAY_SPEECH");
    };

    await voteOut("seat-1", "round-1");
    await waitPhase("NIGHT_WOLF");
    await advanceEmptyNight(true);
    await voteOut("seat-2", "round-2");
    await waitPhase("NIGHT_WOLF");
    await advanceEmptyNight(false);
    await voteOut("seat-9", "round-3");
    await waitPhase("GAME_OVER");
    await expect(host.locator(".recap-panel h2")).toHaveText("好人阵营获胜");
    await expect(host.locator(".revealed-grid > div")).toHaveCount(9);
    expect(publicSnapshot().game.result.winner).toBe("GOOD");

    coverage.push(...await host.coverage.stopJSCoverage());
    const coverageReport = buildCoverageReport(coverage, baseUrl);
    expect(coverageReport.scripts.some((entry) => entry.url.endsWith("/app.js"))).toBe(true);
    expect(coverageReport.scripts.some((entry) => entry.url.includes("/src/client/"))).toBe(true);
    const coveragePath = path.join(artifactDir, "browser-coverage.json");
    await fs.writeFile(coveragePath, `${JSON.stringify(coverageReport, null, 2)}\n`);

    expect(pageErrors).toEqual([]);
    expect(externalRequests.every((url) => !url.startsWith(baseUrl))).toBe(true);
    await Promise.all(contexts.map((context) => context.close()));
  });
});

async function clickActionResponse(page, locator) {
  await expect(locator).toBeEnabled();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/actions") && response.request().method() === "POST"),
    locator.click(),
  ]);
}

async function uiTargetAction(page, targetSeatId, type) {
  await page.locator(`[data-command="select-seat"][data-seat-id="${targetSeatId}"]`).click();
  await clickActionResponse(page, page.locator(`[data-command="submit-action"][data-type="${type}"]:not([data-null="true"])`));
}

function phaseLabel(phase) {
  return {
    ROLE_REVEAL: "确认身份",
    NIGHT_WOLF: "狼人行动",
    NIGHT_WITCH: "女巫行动",
    NIGHT_SEER: "预言家行动",
    DAY_SPEECH: "顺序发言",
    DAY_VOTE: "放逐公投",
    LAST_WORD: "放逐遗言",
    HUNTER_SHOT: "猎人开枪",
    GAME_OVER: "对局结束",
  }[phase];
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

function buildCoverageReport(entries, baseUrl) {
  const scripts = entries
    .filter((entry) => entry.url.startsWith(baseUrl) && (entry.url.endsWith("/app.js") || entry.url.includes("/src/client/")))
    .map((entry) => {
      const usedRanges = entry.functions.flatMap((fn) => fn.ranges)
        .filter((range) => range.count > 0)
        .map((range) => ({ start: range.startOffset, end: range.endOffset }))
        .sort((left, right) => left.start - right.start);
      let usedBytes = 0;
      let end = 0;
      for (const range of usedRanges) {
        const start = Math.max(end, range.start);
        if (range.end > start) usedBytes += range.end - start;
        end = Math.max(end, range.end);
      }
      return { url: entry.url, totalBytes: entry.source.length, usedBytes };
    });
  return {
    collectedAt: new Date().toISOString(),
    note: "Host-session Chrome byte coverage during a nine-context flow; no threshold claim.",
    scripts,
  };
}
