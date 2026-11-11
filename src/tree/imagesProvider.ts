import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import { BoxListItem, ImageItem, ImageUsage } from '../bridge/protocol';
import {
  BoxLiteTreeItem,
  ImageUsageTreeItem,
  ImageGroupTreeItem,
  ImageTreeItem,
  ImageChildTreeItem,
  formatBytes
} from './nodes';

export const BUILTIN_IMAGES = ['base', 'python', 'node', 'sandbaseai-hermes'];

export interface BuildImageListResult {
  builtins: ImageItem[];
  catalog: ImageItem[];
  customOnly: ImageItem[];
  all: ImageItem[];
}

export function buildImageList(
  catalogImages: ImageItem[] = [],
  builtinNames: string[] = BUILTIN_IMAGES,
  customImageNames: string[] = [],
  activeBoxes: BoxListItem[] = [],
  defaultImageName?: string
): BuildImageListResult {
  const normDefault = (defaultImageName || 'python').toLowerCase().trim();

  // Map active box usage by image reference
  const boxesByImage = new Map<string, { id: string; name: string; status: string }[]>();
  for (const b of activeBoxes) {
    const rawImg = (b.image || 'python').trim();
    const key = rawImg.toLowerCase();
    const existing = boxesByImage.get(key) || [];
    existing.push({
      id: b.id,
      name: b.name || `box-${b.id.substring(0, 8)}`,
      status: (b.status || 'unknown').toLowerCase().trim()
    });
    boxesByImage.set(key, existing);
  }

  // 1. Built-in images (free · not counted)
  const builtins: ImageItem[] = builtinNames.map((name) => {
    const key = name.toLowerCase().trim();
    const boxes = boxesByImage.get(key) || [];
    return {
      name,
      builtin: true,
      recorded: true,
      isDefault: key === normDefault,
      boxCount: boxes.length,
      boxes
    };
  });

  const builtinKeys = new Set(builtinNames.map((n) => n.toLowerCase().trim()));

  // 2. Catalog images (excluding built-in names)
  const catalog: ImageItem[] = [];
  const seenCatalogKeys = new Set<string>();

  for (const cat of catalogImages) {
    const key = cat.name.toLowerCase().trim();
    if (builtinKeys.has(key)) {
      continue;
    }
    seenCatalogKeys.add(key);
    const boxes = boxesByImage.get(key) || [];
    catalog.push({
      ...cat,
      builtin: false,
      recorded: true,
      isDefault: key === normDefault,
      boxCount: Math.max(cat.boxCount || 0, boxes.length),
      boxes: boxes.length > 0 ? boxes : cat.boxes
    });
  }

  // Also include in-use images from activeBoxes not yet in catalog or builtins
  for (const [key, boxes] of boxesByImage.entries()) {
    if (!builtinKeys.has(key) && !seenCatalogKeys.has(key)) {
      seenCatalogKeys.add(key);
      const originalName = boxes[0]?.id ? (activeBoxes.find((b) => (b.image || '').toLowerCase().trim() === key)?.image || key) : key;
      catalog.push({
        name: originalName,
        builtin: false,
        recorded: true,
        isDefault: key === normDefault,
        boxCount: boxes.length,
        boxes
      });
    }
  }

  // 3. Custom images from settings (not yet in catalog or built-in)
  const customOnly: ImageItem[] = [];
  for (const customName of customImageNames) {
    const key = customName.toLowerCase().trim();
    if (!key || builtinKeys.has(key) || seenCatalogKeys.has(key)) {
      continue;
    }
    seenCatalogKeys.add(key);
    const boxes = boxesByImage.get(key) || [];
    customOnly.push({
      name: customName.trim(),
      builtin: false,
      recorded: false,
      isDefault: key === normDefault,
      boxCount: boxes.length,
      boxes
    });
  }

  // Sorter: default first, then in-use (boxCount > 0) descending, then alphabetical
  const sorter = (a: ImageItem, b: ImageItem) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    const aBoxes = a.boxCount || (a.boxes ? a.boxes.length : 0);
    const bBoxes = b.boxCount || (b.boxes ? b.boxes.length : 0);
    if (aBoxes > 0 && bBoxes === 0) return -1;
    if (aBoxes === 0 && bBoxes > 0) return 1;
    if (aBoxes !== bBoxes) return bBoxes - aBoxes;
    return a.name.localeCompare(b.name);
  };

  catalog.sort(sorter);
  customOnly.sort(sorter);

  const all = [...builtins, ...catalog, ...customOnly];

  return {
    builtins,
    catalog,
    customOnly,
    all
  };
}

export class ImagesTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedBuiltins: ImageItem[] = [];

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager
  ) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: BoxLiteTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BoxLiteTreeItem): Promise<BoxLiteTreeItem[]> {
    if (!element) {
      // Root level: Catalog Usage + Builtin Group + Catalog & Custom Images
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();

      if (!apiKey) {
        items.push(
          new ImageChildTreeItem(
            'Sign in to BoxLite Cloud',
            'Use the account section above to sign in',
            'sign-in',
            { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' }
          )
        );
        return items;
      }

      try {
        const config = vscode.workspace.getConfiguration('boxlite');
        const customImageNames = config.get<string[]>('customImages', []);
        const defaultImageName = config.get<string>('defaultImage', 'python');

        // Fetch catalog images and active boxes concurrently
        let rawImages: ImageItem[] = [];
        let usage: ImageUsage | undefined;
        try {
          const imgRes = await this.bridge.listImages();
          rawImages = imgRes.images || [];
          usage = imgRes.usage;
        } catch (e: any) {
          const msg = e?.message || '';
          const isAuthOrForbidden =
            msg.includes('403') ||
            msg.toLowerCase().includes('forbidden') ||
            msg.includes('401') ||
            msg.toLowerCase().includes('unauthorized');
          if (isAuthOrForbidden) {
            throw e;
          }
          // If the Cloud API or fallback does not support /images, gracefully degrade
          rawImages = [];
        }

        let activeBoxes: BoxListItem[] = [];
        try {
          activeBoxes = await this.bridge.listBoxes();
        } catch {
          activeBoxes = [];
        }

        const listResult = buildImageList(
          rawImages,
          BUILTIN_IMAGES,
          customImageNames,
          activeBoxes,
          defaultImageName
        );

        this.cachedBuiltins = listResult.builtins;

        // 1. Organization catalog usage row
        const totalKnownBytes = rawImages.reduce((sum, img) => sum + (img.sizeBytes || 0), 0);
        const resolvedUsage: ImageUsage = usage || {
          count: listResult.catalog.length,
          limit: 20,
          knownBytes: totalKnownBytes
        };
        items.push(new ImageUsageTreeItem(resolvedUsage));

        // 2. Built-in images group (free · not counted)
        items.push(
          new ImageGroupTreeItem(
            'Built-in (free · not counted)',
            `${listResult.builtins.length} images · free`,
            'symbol-package',
            vscode.TreeItemCollapsibleState.Expanded
          )
        );

        // 3. Catalog and Custom images
        if (listResult.catalog.length === 0 && listResult.customOnly.length === 0) {
          items.push(
            new ImageChildTreeItem(
              'Use Your Own Image...',
              'Boot any public registry image or connect private registry',
              'add',
              { command: 'boxlite.addImage', title: 'Use Your Own Image...' }
            )
          );
        } else {
          for (const img of listResult.catalog) {
            items.push(new ImageTreeItem(img));
          }
          for (const img of listResult.customOnly) {
            items.push(new ImageTreeItem(img));
          }
        }
      } catch (err: any) {
        const rawMsg = err.message || '';
        const is403 = rawMsg.includes('403') || rawMsg.toLowerCase().includes('forbidden');
        const is401 = rawMsg.includes('401') || rawMsg.toLowerCase().includes('unauthorized');

        let desc = rawMsg;
        let tooltip = rawMsg;
        let command = { command: 'boxlite.refreshImages', title: 'Retry' };

        if (is403) {
          desc = '403 Forbidden · Full access key required for custom images/registries';
          tooltip = `BoxLite Cloud API Error (403): Forbidden resource.\n\nDiagnosis (agent.md §5 & docs.boxlite.ai/cloud/private-images):\nForbidden errors on private registry or catalog calls indicate an API key permission issue. These operations need Full access; a Boxes-only key cannot make them. Click to retry.`;
        } else if (is401) {
          desc = '401 Unauthorized · Invalid credentials';
          tooltip = `BoxLite Cloud API Error (401): Unauthorized.\n\nDiagnosis (agent.md §5):\nCheck credentials. Configure your BOXLITE_API_KEY via "BoxLite: Sign In / Set API Key".`;
          command = { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' };
        } else {
          const firstLine = rawMsg.split('\n')[0];
          desc = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
          tooltip = rawMsg;
        }

        items.push(
          new ImageChildTreeItem(
            'Error loading images',
            desc,
            is403 ? 'lock' : (is401 ? 'key' : 'warning'),
            command,
            vscode.TreeItemCollapsibleState.None,
            is403 ? 'image-forbidden' : 'image-error',
            undefined,
            tooltip
          )
        );
      }

      return items;
    }

    // Children of Built-in Group
    if (element instanceof ImageGroupTreeItem) {
      return this.cachedBuiltins.map((img) => new ImageTreeItem(img));
    }

    // Children of an Image node
    if (element instanceof ImageTreeItem) {
      const img = element.image;
      const children: BoxLiteTreeItem[] = [];

      // 1. Box usage
      if (img.boxes && img.boxes.length > 0) {
        for (const b of img.boxes) {
          children.push(
            new ImageChildTreeItem(
              b.name,
              `${b.status} · ${b.id.substring(0, 8)}`,
              'play-circle',
              {
                command: 'boxlite.inspectBox',
                title: 'Inspect Box',
                arguments: [b.id]
              },
              vscode.TreeItemCollapsibleState.None,
              'image-box-instance',
              img.name,
              `Active Box using image "${img.name}":\nID: ${b.id}\nName: ${b.name}\nStatus: ${b.status}`
            )
          );
        }
      } else {
        children.push(
          new ImageChildTreeItem(
            'No active boxes using this image',
            img.builtin ? 'Click to create a box from this image' : undefined,
            'circle-slash',
            {
              command: 'boxlite.createBoxFromImage',
              title: 'Create Box from Image...',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'image-no-boxes',
            img.name
          )
        );
      }

      // 2. Metadata: Last used / Size (if catalog)
      if (!img.builtin && img.recorded) {
        if (img.lastUsedAt) {
          children.push(
            new ImageChildTreeItem(
              'Last Used',
              img.lastUsedAt,
              'calendar',
              undefined,
              vscode.TreeItemCollapsibleState.None,
              'image-last-used',
              img.name
            )
          );
        }
        if (img.sizeBytes && img.sizeBytes > 0) {
          children.push(
            new ImageChildTreeItem(
              'Recorded Size',
              formatBytes(img.sizeBytes),
              'file-binary',
              undefined,
              vscode.TreeItemCollapsibleState.None,
              'image-size',
              img.name
            )
          );
        }
      }

      // 3. Actions
      // Create Box from Image
      children.push(
        new ImageChildTreeItem(
          'Create Box from Image...',
          `Launch microVM with ${img.name}`,
          'plus',
          {
            command: 'boxlite.createBoxFromImage',
            title: 'Create Box from Image...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'image-action-create',
          img.name
        )
      );

      // Set as Default
      if (!img.isDefault) {
        children.push(
          new ImageChildTreeItem(
            'Set as Default Image',
            'Use as default for future box creation',
            'star',
            {
              command: 'boxlite.setDefaultImage',
              title: 'Set as Default Image',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'image-action-default',
            img.name
          )
        );
      }

      // Inspect Image
      children.push(
        new ImageChildTreeItem(
          'Inspect Image Details',
          'View JSON catalog details and history',
          'json',
          {
            command: 'boxlite.inspectImage',
            title: 'Inspect Image Details',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'image-action-inspect',
          img.name
        )
      );

      // Non-builtin actions: Pin alias & Delete
      if (!img.builtin) {
        children.push(
          new ImageChildTreeItem(
            'Pin Image Alias...',
            'Attach version alias (e.g. stable, prod)',
            'tag',
            {
              command: 'boxlite.pinImageAlias',
              title: 'Pin Image Alias...',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'image-action-alias',
            img.name
          )
        );

        children.push(
          new ImageChildTreeItem(
            'Delete Image',
            'Remove from organization catalog',
            'trash',
            {
              command: 'boxlite.removeImage',
              title: 'Delete Image',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'image-action-delete',
            img.name
          )
        );
      }

      return children;
    }

    return [];
  }
}
