/**
 * Device registry for `dsh-remote-dispatch`.
 *
 * A *device* is one cloud machine the user has bound to this plugin. Binding is
 * an SSH relationship: the device names an ssh credential id from the credential
 * vault, and everything else (host, user, password/key) is read from that record
 * at use time — the registry itself never stores a secret.
 *
 * The registry is a small JSON document kept under the harness home so devices
 * survive restarts and are editable from the Settings page and by the agent.
 *
 * @module dsh-remote-dispatch/devices
 */
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RemoteError } from './ssh.js'

/** Where the registry lives. */
function registryPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return join(home, 'storages', 'dsh-remote-dispatch', 'devices.json')
}

/** Validate a device name: it doubles as a config key and appears in job ids. */
export function normalizeDeviceName(name) {
  const cleaned = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned === '') throw new RemoteError('invalid-name', '设备名不能为空，只能用字母、数字、- _ .')
  return cleaned
}

export class DeviceRegistry {
  /**
   * @param {object} ctx - plugin context.
   * @param {object} settings - resolved plugin config (provides defaults).
   */
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    this.path = registryPath()
    this.cache = undefined
  }

  /** Read the registry document, creating a default one if absent. */
  async load() {
    if (this.cache) return this.cache
    let doc
    try {
      const text = await readFile(this.path, 'utf8')
      doc = JSON.parse(text)
    } catch {
      doc = undefined
    }
    if (!doc || typeof doc !== 'object') {
      // Seed from cordis.patch.yml so existing configs keep working.
      doc = {
        version: 1,
        defaultDevice: this.settings.defaultHost || '',
        devices: {},
      }
      const seeded = this.settings.hosts ?? {}
      for (const [name, entry] of Object.entries(seeded)) {
        doc.devices[name] = {
          name,
          label: entry.label ?? name,
          credentialId: entry.credentialId,
          workRoot: '',
          project: 'default',
          note: '',
          createdAt: new Date().toISOString(),
          source: 'config',
        }
      }
      if (!doc.defaultDevice) doc.defaultDevice = Object.keys(doc.devices)[0] ?? ''
      await this.save(doc)
    }
    this.cache = doc
    return doc
  }

  /** Atomically persist the registry. */
  async save(doc) {
    await mkdir(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
    this.cache = doc
    return doc
  }

  /** Drop the in-memory copy so the next read hits disk. */
  invalidate() {
    this.cache = undefined
  }

  /** List devices, default first-class. */
  async list() {
    const doc = await this.load()
    return {
      defaultDevice: doc.defaultDevice ?? '',
      devices: Object.values(doc.devices ?? {}).sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  /** Resolve a device by name, falling back to the default. */
  async resolve(name) {
    const doc = await this.load()
    const wanted = (name && String(name).trim()) || doc.defaultDevice || Object.keys(doc.devices ?? {})[0]
    const entry = doc.devices?.[wanted]
    if (!entry) {
      const names = Object.keys(doc.devices ?? {})
      throw new RemoteError(
        'unknown-device',
        `没有名为「${wanted || '(空)'}」的设备。已绑定：${names.join(', ') || '(无)'}。` +
          '请在 设置 → 云端派发 → 设备 里用 SSH 关联一台服务器。',
      )
    }
    return entry
  }

  /**
   * Create or update a device binding.
   * @param {object} input - { name, label, credentialId, workRoot, project, note, makeDefault }
   */
  async upsert(input) {
    const name = normalizeDeviceName(input.name ?? input.label)
    const credentialId = String(input.credentialId ?? '').trim()
    if (credentialId === '') {
      throw new RemoteError('credential-required', '请选择一个 SSH 凭据（可用「凭据管家」先新建一台服务器）。')
    }

    const doc = await this.load()
    const existing = doc.devices[name]
    doc.devices[name] = {
      name,
      label: String(input.label ?? '').trim() || name,
      credentialId,
      workRoot: String(input.workRoot ?? '').trim(),
      project: String(input.project ?? '').trim() || 'default',
      note: String(input.note ?? '').trim(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: existing?.source ?? 'user',
    }
    if (input.makeDefault === true || !doc.defaultDevice) doc.defaultDevice = name
    await this.save(doc)
    return doc.devices[name]
  }

  /** Remove a device binding. The ssh credential itself is left untouched. */
  async remove(name) {
    const key = normalizeDeviceName(name)
    const doc = await this.load()
    if (!doc.devices[key]) {
      throw new RemoteError('unknown-device', `没有名为「${key}」的设备。`)
    }
    delete doc.devices[key]
    if (doc.defaultDevice === key) {
      doc.defaultDevice = Object.keys(doc.devices)[0] ?? ''
    }
    await this.save(doc)
    return { removed: key, defaultDevice: doc.defaultDevice }
  }

  /** Choose the default device. */
  async setDefault(name) {
    const key = normalizeDeviceName(name)
    const doc = await this.load()
    if (!doc.devices[key]) throw new RemoteError('unknown-device', `没有名为「${key}」的设备。`)
    doc.defaultDevice = key
    await this.save(doc)
    return { defaultDevice: key }
  }
}
