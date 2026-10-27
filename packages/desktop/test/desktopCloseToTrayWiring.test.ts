import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// 关窗分支是同步回调，真正的判断在 desktopWindowLifecycle；这个用例只守住
// main/index.ts 的接线，防止再次把 closeToTrayOnWindows 直接传给生命周期函数
// 或漏掉 tray/capability 门禁（#77）。
describe("desktop close-to-tray wiring", () => {
  it("passes closeToTray and the capability gate to the lifecycle handler", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

    expect(source).toContain("closeToTray: closeToTrayOnWindows");
    expect(source).toContain("closeToTraySupported: resolveCloseToTraySupported({");
    expect(source).toContain("desktopTrayReady = desktopTray !== null;");
    expect(source).toContain(
      "refreshCloseToTrayCapability: () => closeToTrayCapabilityMonitor.refresh()",
    );
  });
});
