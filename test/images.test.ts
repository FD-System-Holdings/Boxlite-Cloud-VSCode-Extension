import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import {
  ImageTreeItem,
  ImageUsageTreeItem,
  ImageGroupTreeItem,
  ImageChildTreeItem,
  formatBytes
} from '../src/tree/nodes';
import {
  ImagesTreeDataProvider,
  buildImageList,
  BUILTIN_IMAGES
} from '../src/tree/imagesProvider';
import { BoxListItem, ImageItem } from '../src/bridge/protocol';

describe('Images List Building and Sorting', () => {
  it('should include 4 built-in images and flag default image', () => {
    const result = buildImageList([], BUILTIN_IMAGES, [], [], 'python');

    assert.strictEqual(result.builtins.length, 4);
    assert.deepStrictEqual(
      result.builtins.map((b) => b.name),
      ['base', 'python', 'node', 'sandbaseai-hermes']
    );

    const pythonImg = result.builtins.find((b) => b.name === 'python');
    assert.ok(pythonImg);
    assert.strictEqual(pythonImg?.builtin, true);
    assert.strictEqual(pythonImg?.isDefault, true);

    const nodeImg = result.builtins.find((b) => b.name === 'node');
    assert.strictEqual(nodeImg?.builtin, true);
    assert.strictEqual(nodeImg?.isDefault, false);
  });

  it('should map active box counts and box references to images', () => {
    const activeBoxes: BoxListItem[] = [
      { id: 'box_001', name: 'web-prod', status: 'running', image: 'python' },
      { id: 'box_002', name: 'worker-1', status: 'stopped', image: 'python' },
      { id: 'box_003', name: 'node-api', status: 'running', image: 'node' },
      { id: 'box_004', name: 'custom-alpine', status: 'running', image: 'docker.io/library/alpine:3.20' }
    ];

    const catalogImages: ImageItem[] = [
      { name: 'docker.io/library/alpine:3.20', sizeBytes: 3630321 }
    ];

    const result = buildImageList(catalogImages, BUILTIN_IMAGES, [], activeBoxes, 'python');

    const pythonImg = result.builtins.find((b) => b.name === 'python');
    assert.strictEqual(pythonImg?.boxCount, 2);
    assert.strictEqual(pythonImg?.boxes?.length, 2);

    const nodeImg = result.builtins.find((b) => b.name === 'node');
    assert.strictEqual(nodeImg?.boxCount, 1);

    const baseImg = result.builtins.find((b) => b.name === 'base');
    assert.strictEqual(baseImg?.boxCount, 0);

    const alpineImg = result.catalog.find((c) => c.name === 'docker.io/library/alpine:3.20');
    assert.ok(alpineImg);
    assert.strictEqual(alpineImg?.boxCount, 1);
    assert.strictEqual(alpineImg?.builtin, false);
    assert.strictEqual(alpineImg?.recorded, true);
  });

  it('should surface unrecorded custom images from settings', () => {
    const customNames = ['ghcr.io/acme/private-api:latest', 'docker.io/library/ubuntu:24.04'];
    const result = buildImageList([], BUILTIN_IMAGES, customNames, [], 'python');

    assert.strictEqual(result.customOnly.length, 2);
    const customImg = result.customOnly.find((c) => c.name === 'ghcr.io/acme/private-api:latest');
    assert.ok(customImg);
    assert.strictEqual(customImg?.recorded, false);
    assert.strictEqual(customImg?.builtin, false);
  });

  it('should sort catalog items with default first, in-use next, then alphabetical', () => {
    const catalog: ImageItem[] = [
      { name: 'docker.io/library/redis:alpine' },
      { name: 'docker.io/library/alpine:3.20' },
      { name: 'ghcr.io/acme/api:1.4.0' }
    ];

    const activeBoxes: BoxListItem[] = [
      { id: 'b1', name: 'redis-box', status: 'running', image: 'docker.io/library/redis:alpine' }
    ];

    // Set ghcr.io/acme/api:1.4.0 as default image
    const result = buildImageList(catalog, BUILTIN_IMAGES, [], activeBoxes, 'ghcr.io/acme/api:1.4.0');

    // Expected order:
    // 1. ghcr.io/acme/api:1.4.0 (default)
    // 2. docker.io/library/redis:alpine (in-use: 1 box)
    // 3. docker.io/library/alpine:3.20 (unused, alphabetical)
    assert.strictEqual(result.catalog[0].name, 'ghcr.io/acme/api:1.4.0');
    assert.strictEqual(result.catalog[1].name, 'docker.io/library/redis:alpine');
    assert.strictEqual(result.catalog[2].name, 'docker.io/library/alpine:3.20');
  });

  it('should surface in-use images from boxes not present in catalog as recorded catalog images', () => {
    const activeBoxes: BoxListItem[] = [
      { id: 'b1', name: 'app', status: 'running', image: 'quay.io/coreos/etcd:v3.5.0' }
    ];

    const result = buildImageList([], BUILTIN_IMAGES, [], activeBoxes, 'python');
    const etcd = result.catalog.find((c) => c.name === 'quay.io/coreos/etcd:v3.5.0');
    assert.ok(etcd);
    assert.strictEqual(etcd?.boxCount, 1);
    assert.strictEqual(etcd?.recorded, true);
  });

  it('should handle catalog items missing name and non-string customImageNames without throwing', () => {
    const malformedCatalog: any[] = [
      { repository: 'docker.io/library/alpine', tag: '3.20', size_bytes: 3630321 },
      { image_name: 'ghcr.io/acme/worker' },
      { name: undefined },
      null
    ];
    const malformedCustom: any[] = [null, undefined, 123, 'ghcr.io/acme/custom:1.0'];

    const result = buildImageList(malformedCatalog, BUILTIN_IMAGES, malformedCustom, [], 'python');

    const alpine = result.catalog.find((c) => c.name === 'docker.io/library/alpine:3.20');
    assert.ok(alpine);
    assert.strictEqual(alpine?.sizeBytes, 3630321);

    const worker = result.catalog.find((c) => c.name === 'ghcr.io/acme/worker');
    assert.ok(worker);

    assert.strictEqual(result.catalog.length, 2);
    assert.strictEqual(result.customOnly.length, 1);
    assert.strictEqual(result.customOnly[0].name, 'ghcr.io/acme/custom:1.0');
  });
});

describe('Image Tree Item Presentation & Node Formatting', () => {
  it('should format ImageUsageTreeItem correctly with byte sizing and limits', () => {
    const item = new ImageUsageTreeItem({
      count: 2,
      limit: 20,
      knownBytes: 3630321
    });

    assert.strictEqual(item.label, '2 of 20 images · 3.5 MiB');
    assert.strictEqual(item.description, undefined);
    assert.strictEqual(item.contextValue, 'image-usage-item');
    assert.ok(String(item.tooltip || '').includes('Limit: 20 per organization'));
  });

  it('should warn on near-limit and limit-reached in ImageUsageTreeItem', () => {
    const nearLimitItem = new ImageUsageTreeItem({ count: 18, limit: 20, knownBytes: 1000000 });
    assert.strictEqual(nearLimitItem.description, 'Near limit');

    const limitReachedItem = new ImageUsageTreeItem({ count: 20, limit: 20, knownBytes: 5000000 });
    assert.strictEqual(limitReachedItem.description, 'Limit reached');
  });

  it('should format built-in and default ImageTreeItem with appropriate icons and context values', () => {
    const defaultPython = new ImageTreeItem({
      name: 'python',
      builtin: true,
      isDefault: true,
      boxCount: 3
    });

    assert.strictEqual(defaultPython.label, 'python');
    assert.strictEqual(defaultPython.description, '★ default · free · 3 boxes');
    assert.ok(defaultPython.contextValue?.includes('image-builtin'));
    assert.ok(defaultPython.contextValue?.includes('image-default'));
    assert.ok(defaultPython.contextValue?.includes('image-in-use'));

    const customUnbooted = new ImageTreeItem({
      name: 'docker.io/library/alpine:3.20',
      builtin: false,
      recorded: false,
      isDefault: false
    });

    assert.strictEqual(customUnbooted.label, 'docker.io/library/alpine:3.20');
    assert.strictEqual(customUnbooted.description, 'saved (not booted)');
    assert.ok(customUnbooted.contextValue?.includes('image-custom'));
    assert.ok(customUnbooted.contextValue?.includes('image-unrecorded'));
  });

  it('should format formatBytes helper accurately across scales', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1024), '1 KiB');
    assert.strictEqual(formatBytes(1536), '1.5 KiB');
    assert.strictEqual(formatBytes(1048576), '1 MiB');
    assert.strictEqual(formatBytes(3630321), '3.5 MiB');
    assert.strictEqual(formatBytes(1073741824), '1 GiB');
  });
});

describe('ImagesTreeDataProvider Tree Hierarchy & Lifecycle', () => {
  it('should return ONLY the sign-in prompt when signed out', async () => {
    const mockBridge: any = {
      listImages: async () => ({ images: [] }),
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => undefined,
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const items = await provider.getChildren();

    assert.strictEqual(items.length, 1);
    const signinNode = items[0] as ImageChildTreeItem;
    assert.strictEqual(signinNode.label, 'Sign in to BoxLite Cloud');
    assert.strictEqual(signinNode.command?.command, 'boxlite.setApiKey');
  });

  it('should return Usage, Built-in Group, and Images when signed in', async () => {
    const mockBridge: any = {
      listImages: async () => ({
        images: [{ name: 'docker.io/library/alpine:3.20', sizeBytes: 3630321 }],
        usage: { count: 1, limit: 20, knownBytes: 3630321 }
      }),
      listBoxes: async () => [
        { id: 'box_123', name: 'demo-app', status: 'running', image: 'python' }
      ]
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-api-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 3);

    // 1. ImageUsageTreeItem
    assert.ok(rootItems[0] instanceof ImageUsageTreeItem);
    assert.strictEqual((rootItems[0] as ImageUsageTreeItem).label, '1 of 20 images · 3.5 MiB');

    // 2. ImageGroupTreeItem (Built-in)
    assert.ok(rootItems[1] instanceof ImageGroupTreeItem);
    assert.strictEqual((rootItems[1] as ImageGroupTreeItem).label, 'Built-in (free · not counted)');

    // 3. Catalog Image
    assert.ok(rootItems[2] instanceof ImageTreeItem);
    assert.strictEqual((rootItems[2] as ImageTreeItem).image.name, 'docker.io/library/alpine:3.20');
  });

  it('should provide the 4 built-in image nodes when expanding Built-in Group', async () => {
    const mockBridge: any = {
      listImages: async () => ({ images: [] }),
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();
    const groupNode = rootItems.find((i) => i instanceof ImageGroupTreeItem) as ImageGroupTreeItem;
    assert.ok(groupNode);

    const builtinChildren = await provider.getChildren(groupNode);
    assert.strictEqual(builtinChildren.length, 4);
    assert.deepStrictEqual(
      builtinChildren.map((c) => (c as ImageTreeItem).image.name),
      ['base', 'python', 'node', 'sandbaseai-hermes']
    );
  });

  it('should provide complete action hierarchy and box usage under an Image node', async () => {
    const imgItem = new ImageTreeItem({
      name: 'docker.io/library/alpine:3.20',
      builtin: false,
      recorded: true,
      lastUsedAt: '2026-11-10T20:00:00Z',
      sizeBytes: 3630321,
      boxes: [{ id: 'b_123', name: 'alpine-worker', status: 'running' }]
    });

    const provider = new ImagesTreeDataProvider({} as any, { getApiKey: async () => 'k' } as any);
    const children = await provider.getChildren(imgItem);

    // Box usage child
    const boxNode = children.find((c) => c.label === 'alpine-worker');
    assert.ok(boxNode, 'Expected active box child node');
    assert.strictEqual(boxNode?.command?.command, 'boxlite.inspectBox');

    // Create Box action
    const createNode = children.find((c) => c.label === 'Create Box from Image...');
    assert.ok(createNode);
    assert.strictEqual(createNode?.command?.command, 'boxlite.createBoxFromImage');

    // Set Default action
    const defaultNode = children.find((c) => c.label === 'Set as Default Image');
    assert.ok(defaultNode);
    assert.strictEqual(defaultNode?.command?.command, 'boxlite.setDefaultImage');

    // Inspect Details action
    const inspectNode = children.find((c) => c.label === 'Inspect Image Details');
    assert.ok(inspectNode);
    assert.strictEqual(inspectNode?.command?.command, 'boxlite.inspectImage');

    // Pin Alias action (custom only)
    const pinNode = children.find((c) => c.label === 'Pin Image Alias...');
    assert.ok(pinNode);
    assert.strictEqual(pinNode?.command?.command, 'boxlite.pinImageAlias');

    // Delete action (custom only)
    const deleteNode = children.find((c) => c.label === 'Delete Image');
    assert.ok(deleteNode);
    assert.strictEqual(deleteNode?.command?.command, 'boxlite.removeImage');
  });

  it('should present 403 forbidden resource with Full key diagnostic guidance', async () => {
    const mockBridge: any = {
      listImages: async () => {
        throw new Error('BoxLite Cloud API error (403): Forbidden resource\nDiagnosis: 403 Forbidden: For private images or registries, ensure API key has Full access (docs.boxlite.ai/cloud/private-images).');
      },
      listBoxes: async () => {
        throw new Error('403 Forbidden');
      }
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 1);
    const errorItem = rootItems[0];
    assert.strictEqual(errorItem.label, 'Error loading images');
    assert.ok(String(errorItem.description).includes('403 Forbidden'));
    assert.ok(String(errorItem.description).includes('Full access key'));
  });

  it('should gracefully degrade when listImages fails without throwing exception', async () => {
    const mockBridge: any = {
      listImages: async () => {
        throw new Error('Route not found (/images)');
      },
      listBoxes: async () => [
        { id: 'b_1', name: 'py-app', status: 'running', image: 'python' }
      ]
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    // Must successfully return usage and built-ins derived from local state
    const usageNode = rootItems.find((i) => i instanceof ImageUsageTreeItem);
    assert.ok(usageNode);

    const builtinGroup = rootItems.find((i) => i instanceof ImageGroupTreeItem);
    assert.ok(builtinGroup);
  });

  it('should succeed when listImages returns items without name or with undefined names', async () => {
    const mockBridge: any = {
      listImages: async () => ({
        images: [
          { repository: 'docker.io/library/alpine', tag: '3.20', size_bytes: 3630321 },
          { name: undefined },
          { imageName: 'ghcr.io/acme/service:latest' }
        ]
      }),
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    const errorNode = rootItems.find((i) => i.label === 'Error loading images');
    assert.strictEqual(errorNode, undefined);

    const imageLabels = rootItems
      .filter((i): i is ImageTreeItem => i instanceof ImageTreeItem)
      .map((i) => i.image.name);
    assert.deepStrictEqual(imageLabels, [
      'docker.io/library/alpine:3.20',
      'ghcr.io/acme/service:latest'
    ]);
  });
});

describe('Package.json Images UI Contribution Specifications', () => {
  it('should place boxlite.imagesView strictly between boxlite.boxesView and boxlite.volumesView', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const views = pkg.contributes?.views?.['boxlite-explorer'] || [];
    const accountIndex = views.findIndex((v: any) => v.id === 'boxlite.accountView');
    const boxesIndex = views.findIndex((v: any) => v.id === 'boxlite.boxesView');
    const imagesIndex = views.findIndex((v: any) => v.id === 'boxlite.imagesView');
    const volumesIndex = views.findIndex((v: any) => v.id === 'boxlite.volumesView');

    assert.ok(accountIndex >= 0, 'Expected boxlite.accountView to exist');
    assert.ok(boxesIndex >= 0, 'Expected boxlite.boxesView to exist');
    assert.ok(imagesIndex >= 0, 'Expected boxlite.imagesView to exist');
    assert.ok(volumesIndex >= 0, 'Expected boxlite.volumesView to exist');

    assert.ok(accountIndex < boxesIndex, 'Expected boxlite.accountView to be placed above boxlite.boxesView');
    assert.ok(
      boxesIndex < imagesIndex && imagesIndex < volumesIndex,
      `Images view (index ${imagesIndex}) must be strictly between Boxes view (${boxesIndex}) and Volumes view (${volumesIndex})`
    );
  });

  it('should contribute all required image commands with icons and BoxLite category', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const requiredCommands = [
      'boxlite.refreshImages',
      'boxlite.addImage',
      'boxlite.createBoxFromImage',
      'boxlite.setDefaultImage',
      'boxlite.copyImageName',
      'boxlite.inspectImage',
      'boxlite.pinImageAlias',
      'boxlite.removeImage',
      'boxlite.addRegistryLogin'
    ];

    const commands = pkg.contributes?.commands || [];
    for (const cmdId of requiredCommands) {
      const match = commands.find((c: any) => c.command === cmdId);
      assert.ok(match, `Expected command "${cmdId}" to be contributed in package.json`);
      assert.strictEqual(match.category, 'BoxLite');
      assert.ok(match.icon, `Expected command "${cmdId}" to have an icon`);
    }
  });

  it('should contribute boxlite.customImages and updated boxlite.defaultImage configuration', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const props = pkg.contributes?.configuration?.properties || {};
    assert.ok(props['boxlite.customImages'], 'Expected boxlite.customImages configuration property');
    assert.strictEqual(props['boxlite.customImages'].type, 'array');

    assert.ok(props['boxlite.defaultImage'], 'Expected boxlite.defaultImage configuration property');
    assert.strictEqual(props['boxlite.defaultImage'].default, 'python');
  });
});
