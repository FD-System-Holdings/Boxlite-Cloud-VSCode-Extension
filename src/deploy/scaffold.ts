import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DEFAULT_CONFIG } from './project';

export async function scaffoldNewProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  let targetDir: string;

  if (folders && folders.length > 0) {
    targetDir = folders[0].uri.fsPath;
  } else {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Select Destination Folder for New BoxLite Project'
    });
    if (!selected || selected.length === 0) {
      return;
    }
    targetDir = selected[0].fsPath;
  }

  const appName = await vscode.window.showInputBox({
    prompt: 'Enter application / box name',
    value: 'my-boxlite-app',
    validateInput: (v) => (!v.trim() ? 'Name cannot be empty' : null)
  });

  if (!appName) {
    return;
  }

  const appDir = path.join(targetDir, 'app');
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  // 1. app/server.py (matches agent.md canonical foreground healthz server)
  const serverPyContent = `from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import sys

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/healthz':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            super().do_GET()

if __name__ == '__main__':
    port = 8080
    print(f"Starting server on 0.0.0.0:{port}...", flush=True)
    # Must bind 0.0.0.0 for BoxLite Cloud proxy access
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    server.serve_forever()
`;
  fs.writeFileSync(path.join(appDir, 'server.py'), serverPyContent, 'utf-8');

  // 2. app/index.html
  const indexHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hello from BoxLite Cloud</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 480px; }
    h1 { margin-top: 0; color: #38bdf8; }
    p { color: #94a3b8; line-height: 1.6; }
    .status { display: inline-block; background: #065f46; color: #34d399; padding: 4px 12px; border-radius: 9999px; font-size: 0.875rem; font-weight: 600; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>BoxLite Cloud</h1>
    <p>Your application is successfully running inside a secure, microVM BoxLite instance!</p>
    <div class="status">&#10003; /healthz healthy</div>
  </div>
</body>
</html>
`;
  fs.writeFileSync(path.join(appDir, 'index.html'), indexHtmlContent, 'utf-8');

  // 3. boxlite.json
  const boxliteConfig = {
    ...DEFAULT_CONFIG,
    name: appName.trim(),
    appDir: './app'
  };
  fs.writeFileSync(
    path.join(targetDir, 'boxlite.json'),
    JSON.stringify(boxliteConfig, null, 2),
    'utf-8'
  );

  // 4. .boxliteignore
  const boxliteIgnore = `.git
.github
node_modules
.venv
venv
__pycache__
*.pyc
.env
.DS_Store
`;
  fs.writeFileSync(path.join(targetDir, '.boxliteignore'), boxliteIgnore, 'utf-8');

  // 5. .gitignore
  const gitIgnore = `.venv/
__pycache__/
*.pyc
.env
`;
  const gitIgnorePath = path.join(targetDir, '.gitignore');
  if (!fs.existsSync(gitIgnorePath)) {
    fs.writeFileSync(gitIgnorePath, gitIgnore, 'utf-8');
  }

  const doc = await vscode.workspace.openTextDocument(path.join(targetDir, 'boxlite.json'));
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(`BoxLite project "${appName}" created successfully! Run "BoxLite: Deploy to Box" to deploy.`);
}
