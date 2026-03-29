export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function clear(node) {
  if (node) node.replaceChildren();
}

export function text(node, value) {
  if (node) node.textContent = value ?? '';
}

export function show(node, visible = true) {
  if (!node) return;
  node.style.display = visible ? '' : 'none';
}

export function setNotice(node, message, tone = 'success') {
  if (!node) return;
  node.textContent = message;
  node.className = `qfu-inline-notice is-${tone}`;
  node.style.display = 'block';
}

export function create(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.text != null) node.textContent = options.text;
  if (options.html != null) node.innerHTML = options.html;
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => {
      if (value != null) node.setAttribute(key, String(value));
    });
  }
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      if (value != null) node.dataset[key] = String(value);
    });
  }
  if (options.children) {
    options.children.forEach((child) => {
      if (child != null) node.appendChild(child);
    });
  }
  return node;
}

export function appendTextPair(primary, secondary) {
  return create('td', {
    children: [create('strong', { text: primary }), create('span', { text: secondary })],
  });
}

export function badge(textValue, className) {
  return create('span', { className: `qfu-badge ${className}`, text: textValue });
}
