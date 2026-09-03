export const phaseZeroBaseline = Object.freeze({
  desktopShell: "electron",
  frontend: "react-typescript-vite",
  runner: "node",
  modelingSkill: "solidworks-autobuild"
});

export function hasPhaseZeroBaseline(): boolean {
  return Object.values(phaseZeroBaseline).every((value) => value.length > 0);
}
