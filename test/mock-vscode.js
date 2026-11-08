const Module = require('module');
const originalRequire = Module.prototype.require;

const mockVscode = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (_key, def) => def
    }),
    openTextDocument: async () => ({}),
  },
  window: {
    showInformationMessage: async () => {},
    showErrorMessage: async () => {},
    showWarningMessage: async () => {},
    createOutputChannel: () => ({
      append: () => {},
      appendLine: () => {},
      show: () => {},
      dispose: () => {}
    }),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {}
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file' }),
    parse: (u) => ({ toString: () => u })
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = (listener) => {
        this.listener = listener;
      };
    }
    fire(data) {
      if (this.listener) this.listener(data);
    }
  },
  Disposable: class {
    dispose() {}
  }
};

Module.prototype.require = function (id) {
  if (id === 'vscode') {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments);
};
