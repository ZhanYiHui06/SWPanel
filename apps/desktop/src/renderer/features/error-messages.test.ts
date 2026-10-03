import { describe, expect, it } from "vitest";

import { describeError } from "./error-messages.js";

describe("describeError", () => {
  it("maps known codes to actionable Chinese regardless of the server message", () => {
    expect(describeError({ code: "TOKEN_NOT_FOUND", message: "The requested business operation could not be completed" })).toEqual({
      message: "上传凭证已过期或已被使用，请重新选择文件",
      code: "TOKEN_NOT_FOUND"
    });
    expect(describeError(Object.assign(new Error("x"), { code: "DRAWING_NUMBER_DUPLICATE" })).message).toBe("图号已存在，请更换图号");
    expect(describeError({ code: "NETWORK_ERROR", message: "无法连接 Web API 服务" }).message).toContain("无法连接 SWPanel 服务");
  });

  it("keeps a Chinese server message for an unknown code and exposes the code", () => {
    expect(describeError({ code: "SOMETHING_NEW", message: "库存不足，请补货" })).toEqual({
      message: "库存不足，请补货",
      code: "SOMETHING_NEW"
    });
  });

  it("never shows English or legacy generic messages for unknown codes", () => {
    expect(describeError({ code: "SOMETHING_NEW", message: "boom" }).message).toMatch(/操作未能完成/);
    expect(describeError({ code: "UNKNOWN", message: "The requested business operation could not be completed" }).message).toMatch(/操作未能完成/);
    const plain = describeError(new Error("TypeError: x is undefined"));
    expect(plain.message).toMatch(/操作未能完成/);
    expect(plain.code).toBeUndefined();
    expect(describeError(undefined).message).toMatch(/操作未能完成/);
  });
});
