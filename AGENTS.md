**Purpose**
- Explain how to build UI in Rainy using its Component and Context systems.
- Show practical patterns with the modern element builders (H/h/s), attributes (a), events (on), props (p), and refs.

**AI Agent Quickstart**
- Identify the target component(s) and read their imports to mirror patterns and style.
- Prefer H.of/h/s for element creation, a for attributes, on for events, p for child props, and useRef for element handles.
- Drive dynamic UI via this.watch; avoid wholesale re-rendering.
- Use useContext for app-wide state; keep transient UI state local in components.
- Return exactly one root element from render and use slots for composition.
- Verify changes by scanning for runtime errors and aligning with existing components’ structure.

**Core Concepts**
- Components: Custom elements subclassing a base Component with lifecycle and state helpers. See [index.js](static/js/components/index.js).
- Context: Lightweight key-path state store with get, set, and watch APIs. See [context.js](static/js/helper/context.js).
- Element builders:
  - H.of(Component|tag, ...): create elements or registered components.
  - h.tag(...): HTML tags via proxy.
  - s.tag(...): SVG tags via proxy.
  - a.attr(value): attributes via proxy.
  - on.event(listener): event bindings via proxy.
  - p.name(value): pass props into child components (maps to child.set, silent).
  - Refs via useRef to capture element handles.

**Component Model**
- Extend Component and define static componentName.
- Implement created for initial state and watchers.
- Implement render to return one root element built via H.of/h/s.
- Register with customElements.define(Class.componentName, Class).
- Lifecycle:
  - created runs in constructor before mount.
  - connectedCallback mounts and calls _render once.
  - disconnectedCallback unsubscribes watchers and calls destroyed if present.
  - Use connectedMoveCallback to avoid re-mount on DOM moves.

**Context API**
- Per-component context: this.get(path), this.set(path, value, { silent? }), this.watch(path, callback, deep?).
- Paths are dot-separated, resolved relative to the component’s internal store.
- set emits only when oldValue !== newValue and parent exists.
- watch receives (path, oldValue, newValue); with deep=true it triggers for child paths of listener.path.
- Global singleton via useContext() for cross-app state (e.g., current view). Example usage in [app.js:L39-L47](static/js/app.js#L39-L47).

**Templating and Binding (Modern API)**
- Create elements:
  - Use H.of(Component, ...) to instantiate a child component.
  - Use h.div(...), h.button(...), etc. for HTML; s.svg(...) for SVG.
- Attributes and events:
  - a.class('btn', 'primary') sets class.
  - a.id('x'), a['data-role']('play') for data-attrs.
  - on.click(() => ...) for event handlers.
- Props to child components:
  - p.title(value) maps to child.set('title', value, { silent: true }).
  - Names are converted to kebab-case (onOpen -> on-open). See [index.js](static/js/components/index.js#L232-L240).
- Refs:
  - const ref = useRef(null); pass ref to H.of/h/s to capture the element; then use ref.value in code.
- Slots:
  - Put h.slot(a.name('slot-name')) in a component’s render. Children passed to H.of(Component) can declare a.slot('slot-name') attributes to place into slots.

**Minimal Component Example**

```javascript
import { a, Component, h, on, useRef } from './static/js/components/index.js';

export class Counter extends Component {
  static componentName = 'rainy-counter';

  created() {
    this.set('count', 0);
    this._valueEl = useRef(null);
    this.watch('count', (_path, _old, v) => {
      this._valueEl.value.textContent = String(v);
    });
  }

  increment = () => this.set('count', this.get('count') + 1);

  render() {
    return h.div(a.class('counter'),
      h.span(this._valueEl, a.class('value'), String(this.get('count'))),
      h.button(a.class('btn'), on.click(this.increment), 'Inc')
    );
  }
}

customElements.define(Counter.componentName, Counter);
```

**Passing State to Child Components**

```javascript
import { a, Component, H, p } from './static/js/components/index.js';
import { Child } from './static/js/components/child.js';

export class Parent extends Component {
  static componentName = 'rainy-parent';

  created() {
    this.set('title', 'Hello');
  }

  render() {
    return H.of(Child, p.title(this.get('title')));
  }
}

customElements.define(Parent.componentName, Parent);
```

**Patterns and Practices**
- Render once, update via watchers: dynamic UI changes should be driven by this.watch handlers; avoid wholesale re-render.
- Always return a single root element from render.
- Bind events via on.* so handler ‘this’ refers to the component.
- Forward state to children via p.* props; avoid ad-hoc attributes that don’t map to child.set.
- Prefer useContext for app-wide flags and keep complex UI state local to components.
- Use Refs for frequently accessed elements to avoid repeated querySelector calls.

**Real Examples in Codebase**
- Modal:
  - Hidden state with watchers, slots for header/body/actions. See [modal.js](static/js/components/modal.js#L1-L60).
- Context Menu:
  - Position logic, show/hide, submenu positioning, and p.onOpen callbacks. See [contextMenu.js](static/js/components/contextMenu.js).
- New Playlist Modal:
  - Uses H.of(Modal), Refs, and props. See [newPlaylistModal.js](static/js/components/newPlaylistModal.js).
- Song Context Menu:
  - Uses Refs, global useContext, and dynamic submenu rendering. See [songContextMenu.js](static/js/components/songContextMenu.js).

**Integration Checklist**
- Define a Component subclass and static componentName.
- Initialize state in created via this.set and set watchers with this.watch.
- Implement render using H.of/h/s and return one root element; use slots as needed.
- Register the element with customElements.define.
- Wire events using on.* and forward state to children with p.*.
- Use useContext for cross-view or global flags; keep complex UI state local.

**Gotchas**
- set is a no-op if path parent doesn’t exist; initialize keys first via this.set in created.
- watch triggers only when oldValue !== newValue; mutate with new objects if you need emissions.
- Props names are converted to kebab-case; ensure you reference the same name in child.get/watch.

**Agent Editing Rules**
- Prefer updating existing files; create new files only if required for functionality.
- Mirror naming and structural conventions of nearby components before introducing new patterns.
- Use Refs for frequently accessed nodes; avoid repeated querySelector unless unavoidable.
- Forward state via p.* and bind events via on.*; do not introduce ad-hoc attributes that do not map to child.set.
- Avoid adding external libraries; implement with the existing helper system and services.
- Do not log or expose secrets; keep user data safe.

**Agent Search Strategy**
- Start broad (feature or flow name), then narrow (component or service) to gather full context.
- Inspect imports and their implementations to understand dependencies and patterns.
- Confirm usage across real examples: modal, context menu, playlist modal, metadata modal.
- Keep exploring until confident the change aligns with the app’s conventions.

**Common Tasks**
- Add a button/state to an existing modal:
  - Create a Ref for the element; add on.click; update visual state via a watcher.
- Add a context menu item:
  - Use H.of(ContextMenuItem) with on.click; if submenu, add ContextSubMenu and use p.onOpen where needed.
- Update UI based on global view:
  - Listen to useContext().listen('current-view-type', ...) and toggle visibility via class changes or component state.
