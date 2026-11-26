// One reading of the operating system's own view of the current network path.
// `null` means the system did not report that value, never a guessed default:
// the application falls back to normal data use on an unknown reading instead
// of probing the network to find out.
export type NativeNetworkSignals = {
  supported: boolean;
  connected: boolean | null;
  expensive: boolean | null;
  constrained: boolean | null;
};
