import { Component, type ReactNode } from 'react'
import { ErrorState } from './States'

/**
 * Contains a render crash to one tab. Without it React unmounts the whole
 * tree on an uncaught render error, so a bug in, say, the Starlink map
 * (WebGL, a malformed data refresh) would blank the launch dashboard too.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    console.error('Tab crashed', error)
  }

  render() {
    if (this.state.error != null) {
      return <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}
