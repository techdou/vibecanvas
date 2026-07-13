import { useMemo, useState } from 'react'
import { Save, X } from 'lucide-react'
import type { VibeCanvasConfigFile } from '../../core/types.js'

export function ProviderSettings({ config, onClose, onSave }: { config: VibeCanvasConfigFile; onClose: () => void; onSave: (id: string, profile: Record<string, unknown>) => Promise<void> }) {
  const id = config.activeProviderId
  const original = config.providers[id]
  const [profile, setProfile] = useState(() => structuredClone(original))
  const [headersText, setHeadersText] = useState(() => JSON.stringify(original.headers, null, 2))
  const [downloadHeadersText, setDownloadHeadersText] = useState(() => JSON.stringify(original.downloadHeaders, null, 2))
  const [extraJsonText, setExtraJsonText] = useState(() => JSON.stringify(original.extraJson, null, 2))
  const [jsonError, setJsonError] = useState('')
  const set = (key: string, value: unknown) => setProfile((current) => ({ ...current, [key]: value }))
  const capabilityKeys = useMemo(() => Object.keys(profile.capabilities) as Array<keyof typeof profile.capabilities>, [profile.capabilities])
  const parseJson = (value: string, key: 'headers' | 'downloadHeaders' | 'extraJson') => {
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象')
      setProfile((current) => ({ ...current, [key]: parsed }))
      setJsonError('')
    } catch (error) { setJsonError(`${key}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const parseForSave = (value: string, key: string): Record<string, unknown> => {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${key} 必须是 JSON 对象`)
    return parsed as Record<string, unknown>
  }
  const save = async () => {
    try {
      const payload = {
        ...profile,
        headers: parseForSave(headersText, 'headers'),
        downloadHeaders: parseForSave(downloadHeadersText, 'downloadHeaders'),
        extraJson: parseForSave(extraJsonText, 'extraJson')
      }
      setJsonError('')
      await onSave(id, payload as unknown as Record<string, unknown>)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }
  return <div className="modal-backdrop"><section className="modal-card settings-modal"><header><div><strong>Provider 能力配置</strong><small>统一配置文件同时供 Web、CLI 和 MCP 使用。保存后需要重启进程。</small></div><button onClick={onClose}><X /></button></header>
    <div className="settings-grid">
      <label>名称<input value={profile.label} onChange={(e) => set('label', e.target.value)} /></label>
      <label>模型<input value={profile.model} onChange={(e) => set('model', e.target.value)} /></label>
      <label className="wide">Base URL<input value={profile.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} /></label>
      <label className="wide">API Key<input type="password" value={profile.apiKey} onChange={(e) => set('apiKey', e.target.value)} /></label>
      <label>生成路径<input value={profile.generatePath} onChange={(e) => set('generatePath', e.target.value)} /></label>
      <label>编辑路径<input value={profile.editPath} onChange={(e) => set('editPath', e.target.value)} /></label>
      <label>图片字段<input value={profile.editImageField} onChange={(e) => set('editImageField', e.target.value)} /></label>
      <label>输出格式<select value={profile.outputFormat} onChange={(e) => set('outputFormat', e.target.value)}><option>png</option><option>webp</option><option>jpeg</option></select></label>
      <label>超时（毫秒）<input type="number" min="1000" value={profile.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))} /></label>
      <label>最大重试<input type="number" min="0" max="10" value={profile.maxRetries} onChange={(e) => set('maxRetries', Number(e.target.value))} /></label>
      <label>最大参考图<input type="number" min="0" max="20" value={profile.capabilities.maxReferences} onChange={(e) => setProfile((current) => ({ ...current, capabilities: { ...current.capabilities, maxReferences: Number(e.target.value) } }))} /></label>
      <label>最大候选图<input type="number" min="1" max="20" value={profile.capabilities.maxCandidates} onChange={(e) => setProfile((current) => ({ ...current, capabilities: { ...current.capabilities, maxCandidates: Number(e.target.value) } }))} /></label>
      <label className="wide toggle-setting"><input type="checkbox" checked={profile.allowPrivateImageUrls} onChange={(e) => set('allowPrivateImageUrls', e.target.checked)} />允许下载私网图片 URL（仅可信中转站）</label>
      <label className="wide">允许的图片主机（逗号分隔）<input value={profile.allowedImageHosts.join(', ')} onChange={(e) => set('allowedImageHosts', e.target.value.split(',').map((item) => item.trim()).filter(Boolean))} /></label>
      <label className="wide">请求 Headers JSON<textarea rows={4} value={headersText} onChange={(e) => { setHeadersText(e.target.value); parseJson(e.target.value, 'headers') }} /></label>
      <label className="wide">图片下载 Headers JSON<textarea rows={4} value={downloadHeadersText} onChange={(e) => { setDownloadHeadersText(e.target.value); parseJson(e.target.value, 'downloadHeaders') }} /></label>
      <label className="wide">额外请求参数 JSON<textarea rows={4} value={extraJsonText} onChange={(e) => { setExtraJsonText(e.target.value); parseJson(e.target.value, 'extraJson') }} /></label>
      {jsonError ? <p className="settings-error wide">{jsonError}</p> : null}
    </div>
    <h3>能力开关</h3><div className="capability-grid">{capabilityKeys.filter((key) => typeof profile.capabilities[key] === 'boolean').map((key) => <label key={String(key)}><input type="checkbox" checked={Boolean(profile.capabilities[key])} onChange={(e) => setProfile((current) => ({ ...current, capabilities: { ...current.capabilities, [key]: e.target.checked } }))} />{String(key)}</label>)}</div>
    <h3>单张估算费用（USD）</h3><div className="cost-grid">{(['low','medium','high','auto'] as const).map((key) => <label key={key}>{key}<input type="number" step="0.0001" value={profile.costs[key]} onChange={(e) => setProfile((current) => ({ ...current, costs: { ...current.costs, [key]: Number(e.target.value) } }))} /></label>)}<label>edit 倍率<input type="number" min="0" step="0.1" value={profile.costs.editMultiplier} onChange={(e) => setProfile((current) => ({ ...current, costs: { ...current.costs, editMultiplier: Number(e.target.value) } }))} /></label></div>
    <footer><button onClick={onClose}>取消</button><button className="primary" disabled={Boolean(jsonError)} onClick={() => void save()}><Save size={15} />保存并重启</button></footer>
  </section></div>
}
