import { Component, type ReactNode } from 'react';

// One view that breaks must not take the window with it. React only lets a class catch an error thrown while
// drawing, so this is the one class in the app. An empty picture card once made the command bar throw, and with
// nothing to catch it the whole stage went blank: the people, the documents, everything. Now the view that broke
// says so in a line, and whatever is underneath stays where it was. `name` changing (another view opened) clears it.
export class Guard extends Component<{ name: string; onClose?: () => void; quiet?: boolean; children: ReactNode }, { broke: string | null }> {
  state = { broke: null as string | null };
  static getDerivedStateFromError() { return { broke: 'yes' }; }
  componentDidCatch(error: Error) { console.error(`the ${this.props.name} view could not be drawn:`, error); }
  componentDidUpdate(before: { name: string }) { if (before.name !== this.props.name && this.state.broke) this.setState({ broke: null }); }

  render() {
    if (!this.state.broke) return this.props.children;
    // A slice's own layer that is normally invisible stays invisible: there is nothing the founder was looking at.
    if (this.props.quiet) return null;
    return (
      <div className="panel guard" role="alertdialog" aria-label="Something went wrong">
        <p>This view ran into a problem and could not be shown. Nothing was lost, and everything behind it is as you left it.</p>
        <button type="button" className="nodrag" onClick={() => { this.setState({ broke: null }); this.props.onClose?.(); }}>Close</button>
      </div>
    );
  }
}
