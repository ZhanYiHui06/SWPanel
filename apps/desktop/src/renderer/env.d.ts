/// <reference types="vite/client" />
declare module "@swpanel/ui/styles";
type SwpanelBridgeApi = import("../main/bridge/bridge-contract.js").SwpanelBridgeApi;
interface Window {
  readonly swpanel?: Readonly<SwpanelBridgeApi>;
}
