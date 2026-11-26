import { Component } from "react";
import { captureViewError } from "../lib/deferredObservability.js";

// The boundary main.jsx renders around the App. It stands in for
// Sentry.ErrorBoundary so the SDK stays out of the entry chunk; a render error
// it catches still reaches error monitoring, queued until the SDK loads.
export class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    captureViewError(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
