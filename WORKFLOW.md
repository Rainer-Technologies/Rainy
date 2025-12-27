**Purpose**
- Explain how to interact with Rainy’s frontend using its Component and Context systems.
- Provide practical patterns and examples for adding UI, wiring events, and managing state without introducing external libraries.

**Core Concepts**
- Components: Custom elements subclassing a base Component with lifecycle and state helpers. See [index.js](static/js/components/index.js).
- Context: Lightweight key-path state store with get, set, and watch APIs. See [context.js](static/js/helper/context.js).
- Templates: html(userdata) tagged template function that builds DOM and binds events/values via placeholders. See [index.js](static/js/components/index.js#L169-L193).

**Component Model**
- Extend Component and define static componentName.
- Implement created for initial state and watchers.
- Implement render to return a single root element built via html(this).
- Register with customElements.define(Class.componentName, Class).
- Lifecycle:
  - created runs in constructor before mount.
  - connectedCallback mounts and calls _render once.
  - disconnectedCallback unsubscribes watchers and calls destroyed if present.
  - Use connectedMoveCallback to avoid re-mount on DOM moves.

**Context API**
- Per-component context is available as this.get(path), this.set(path, value), this.watch(path, callback, deep?).
- Paths are dot-separated, resolved relative to the component’s internal store.
- set emits only when oldValue !== newValue and parent exists.
- watch receives (path, oldValue, newValue); with deep=true it also triggers for child paths of listener.path.
- Global singleton via useContext() for cross-app state (e.g., current view). Example usage in [app.js:L39-L47](static/js/app.js#L39-L47).

**Templating and Binding**
- Use html(this) to create DOM from template strings.
- Event binding: add attributes prefixed with :event and pass a function value.
  - Example: :click=${this.hide} adds a click listener and binds this to userdata passed to html (typically the component).
- Property-to-child-context binding: use attributes prefixed with &path to call child.set(path, value).
  - Example: &title=${song.title} calls child.set('title', song.title) when the child is a Component.
- Plain attributes/text: placeholders are replaced with stringified values; passing HTMLElements or arrays inserts them into the DOM.
- Slots:
  - Put <slot> elements in render output.
  - Children of the component are projected into matching slots by name; unnamed slots receive un-slotted children.

**Minimal Component Example**

```javascript
import { Component, html } from './static/js/components/index.js';

export class Counter extends Component {
  static componentName = 'rainy-counter';

  created() {
    this.set('count', 0);
    this.watch('count', (_path, _old, v) => {
      this.root.querySelector('.value').textContent = String(v);
    });
  }

  increment = () => this.set('count', this.get('count') + 1);

  render() {
    return html(this)`<div class="counter">
      <span class="value">${this.get('count')}</span>
      <button :click=${this.increment}>Inc</button>
    </div>`;
  }
}

customElements.define(Counter.componentName, Counter);
```

**Passing State to Child Components**

```javascript
import { Component, html } from './static/js/components/index.js';

export class Parent extends Component {
  static componentName = 'rainy-parent';

  created() {
    this.set('title', 'Hello');
  }

  render() {
    // &title forwards value to child.set('title', value)
    return html(this)`<div>
      <rainy-child &title=${this.get('title')}></rainy-child>
    </div>`;
  }
}

customElements.define(Parent.componentName, Parent);
```

**Patterns and Practices**
- Render once, update via watchers: _render is called on mount; dynamic UI changes should be driven by this.watch handlers rather than re-rendering wholesale.
- Always return a single root element from render.
- Bind events via :event to ensure handler ‘this’ refers to the component.
- Forward state to children via &path; avoid inventing custom attributes unless they map to child.set.
- Prefer useContext for app-wide flags (e.g., current-view-type) and per-component context for local state.
- Register elements where they are defined; see [modal.js](static/js/components/modal.js) and [contextMenu.js](static/js/components/contextMenu.js) for examples.

**Real Examples in Codebase**
- Modal:
  - Component setup, hidden state, :click binding for close button. See [modal.js](static/js/components/modal.js#L1-L61).
- Context Menu:
  - Multiple components, position logic, show/hide via context. See [contextMenu.js](static/js/components/contextMenu.js).
- Metadata Modal:
  - Stateful UI, data-driven rendering with watchers and slot usage. See [metadataModal.js](static/js/components/metadataModal.js).
- Global state:
  - Set current view via useContext().set(...). See [app.js:L39-L47](static/js/app.js#L39-L47).

**Integration Checklist**
- Define a Component subclass and static componentName.
- Initialize state with this.set in created and react via this.watch.
- Implement render using html(this) and return one root element with slots as needed.
- Register the element with customElements.define.
- Wire events using :event and pass functions; forward state to children using &path.
- Use useContext for cross-view or global flags; keep complex UI state local to components.

**Gotchas**
- set is a no-op if path parent doesn’t exist; initialize keys first via this.set in created.
- watch triggers only when oldValue !== newValue; mutating objects in place may not fire. Replace with new objects when needed.
- Attribute placeholder replacement is designed for single placeholder per attribute; prefer one value per attribute or assemble strings in JS before binding.
