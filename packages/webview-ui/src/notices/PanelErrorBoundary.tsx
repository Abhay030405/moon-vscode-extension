// If drawing the panel throws, show the error (instead of a blank panel), report it to the
// extension's Moon output channel, and offer to start the panel again.

import { Component, type ReactNode } from "react";
import { postToExtension } from "../vscode-api";

interface State {
  error: Error | undefined;
}

export class PanelErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    postToExtension({ type: "panel-error", message: `${error.stack ?? error.message}\n${info.componentStack ?? ""}` });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="moon-messages">
        <div className="moon-notice error">The Moon panel hit an error: {this.state.error.message}</div>
        <div className="moon-notice">Details are in the Moon output channel.</div>
        <div>
          <button onClick={() => this.setState({ error: undefined })}>Reload panel</button>
        </div>
      </div>
    );
  }
}
