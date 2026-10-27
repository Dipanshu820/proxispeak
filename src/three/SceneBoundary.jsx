import { Component } from 'react'

// If the renderer throws after mounting (lost context, driver failure), the rest
// of the page must keep working. The parent is told so it can show the 2D floor.
export default class SceneBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    this.props.onError?.(error)
  }

  render() {
    if (this.state.failed) return null
    return this.props.children
  }
}
