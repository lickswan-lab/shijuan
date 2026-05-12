// FeatureTourModal: first-run walkthrough aligned with the 1.3.3 interface.
// It uses small, simplified UI replicas rather than abstract screenshots, so
// the guide stays readable when the main window is narrow.

import { useCallback, useEffect, useState } from 'react'
import { useUiStore } from '../../store/uiStore'

const FLAG_KEY = 'sj-feature-tour-shown-v133'

interface Step {
  title: string
  label: string
  body: JSX.Element
  icon: JSX.Element
  visual: JSX.Element
}

const iconStyle = {
  stroke: 'currentColor',
  strokeWidth: 1.8,
  fill: 'none',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const ImportIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <polyline points="9 15 12 12 15 15" />
  </svg>
)

const ReaderIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M9 7h7M9 11h7M9 15h4" />
  </svg>
)

const MarkIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M9 11l-6 6v3h3l6-6" />
    <path d="M14 5l5 5" />
    <path d="M16 3l5 5-9 9-5-5z" />
  </svg>
)

const NotesIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M4 4h16v16H4z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
)

const DialogueIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M12 2 2 7l10 5 10-5-10-5z" />
    <path d="M2 12l10 5 10-5" />
    <path d="M2 17l10 5 10-5" />
  </svg>
)

const SummonIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M12 2l2.4 4.9L20 8l-4 3.9.9 5.6L12 14.8 7.1 17.5 8 11.9 4 8l5.6-1.1L12 2z" />
    <path d="M5 21h14" />
  </svg>
)

const KBD: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 24,
    height: 20,
    padding: '0 7px',
    border: '1px solid var(--border)',
    borderBottomWidth: 2,
    borderRadius: 5,
    background: 'var(--bg)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontFamily: 'ui-monospace, Consolas, monospace',
    lineHeight: 1,
  }}>{children}</span>
)

const Pill: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({ children, accent = false }) => (
  <span style={{
    display: 'inline-flex',
    alignItems: 'center',
    height: 23,
    padding: '0 9px',
    borderRadius: 999,
    border: accent ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: accent ? 'rgba(195, 141, 92, 0.10)' : 'var(--bg)',
    color: accent ? 'var(--accent)' : 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: accent ? 600 : 400,
    whiteSpace: 'nowrap',
  }}>{children}</span>
)

const MiniButton: React.FC<{ children: React.ReactNode; active?: boolean; compact?: boolean }> = ({
  children,
  active = false,
  compact = false,
}) => (
  <span style={{
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: compact ? 24 : 28,
    padding: compact ? '0 8px' : '0 11px',
    borderRadius: 7,
    border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: active ? 'var(--accent)' : 'var(--bg)',
    color: active ? '#fff' : 'var(--text-secondary)',
    fontSize: compact ? 11 : 12,
    fontWeight: active ? 650 : 500,
    whiteSpace: 'nowrap',
  }}>{children}</span>
)

const MiniTab: React.FC<{ children: React.ReactNode; active?: boolean }> = ({ children, active = false }) => (
  <span style={{
    flex: 1,
    height: 34,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    color: active ? 'var(--accent)' : 'var(--text-muted)',
    fontSize: 12,
    fontWeight: active ? 650 : 500,
  }}>{children}</span>
)

const MockLine: React.FC<{ w?: string; h?: number; accent?: boolean }> = ({ w = '100%', h = 6, accent = false }) => (
  <div style={{
    width: w,
    height: h,
    borderRadius: 999,
    background: accent ? 'rgba(195, 141, 92, 0.36)' : 'var(--border)',
    opacity: accent ? 1 : 0.82,
  }} />
)

const PreviewFrame: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{
    border: '1px solid var(--border-light)',
    borderRadius: 10,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0.08))',
    padding: 12,
    marginBottom: 14,
  }}>
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
      fontSize: 12,
      color: 'var(--text-muted)',
    }}>
      <span>界面指引</span>
      <span style={{ color: 'var(--accent)', fontWeight: 650 }}>{label}</span>
    </div>
    {children}
  </div>
)

const SidebarIconButton: React.FC<{ active?: boolean; children: React.ReactNode }> = ({ active = false, children }) => (
  <div style={{
    flex: 1,
    height: 34,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    background: active ? 'var(--accent-soft)' : 'transparent',
  }}>
    {children}
  </div>
)

const ImportPreview = () => (
  <PreviewFrame label="左侧文献栏底部">
    <div style={{
      display: 'grid',
      gridTemplateColumns: '190px 1fr',
      minHeight: 150,
      border: '1px solid var(--border)',
      borderRadius: 9,
      overflow: 'hidden',
      background: 'var(--bg)',
    }}>
      <div style={{ borderRight: '1px solid var(--border-light)' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
          <MiniTab active>文献库</MiniTab>
          <MiniTab>笔记</MiniTab>
        </div>
        <div style={{ padding: '10px 10px 7px' }}>
          <div style={{
            height: 30,
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--text-muted)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
          }}>搜索文献 / 全文搜索...</div>
        </div>
        <div style={{
          display: 'flex',
          gap: 5,
          padding: '0 10px 10px',
          borderBottom: '1px solid var(--border-light)',
        }}>
          <SidebarIconButton active>
            <svg width="17" height="17" viewBox="0 0 24 24" {...iconStyle}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <polyline points="9 15 12 12 15 15" />
            </svg>
          </SidebarIconButton>
          <SidebarIconButton>
            <svg width="17" height="17" viewBox="0 0 24 24" {...iconStyle}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="17" x2="12" y2="11" />
              <polyline points="9 14 12 11 15 14" />
            </svg>
          </SidebarIconButton>
          <SidebarIconButton>
            <svg width="17" height="17" viewBox="0 0 24 24" {...iconStyle}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </SidebarIconButton>
          <SidebarIconButton>
            <svg width="17" height="17" viewBox="0 0 24 24" {...iconStyle}>
              <rect x="5" y="5" width="14" height="14" rx="2.5" />
              <path d="m8.6 12.2 2.2 2.3 4.7-5.1" />
            </svg>
          </SidebarIconButton>
        </div>
      </div>
      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
        <MockLine w="48%" h={8} />
        <MockLine w="84%" />
        <MockLine w="72%" />
        <MockLine w="90%" />
      </div>
    </div>
  </PreviewFrame>
)

const ReaderPreview = () => (
  <PreviewFrame label="阅读器顶部工具栏">
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 9,
      overflow: 'hidden',
      background: 'var(--bg)',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(130px, 1fr) auto auto auto',
        alignItems: 'center',
        gap: 9,
        minHeight: 52,
        padding: '9px 12px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 13,
            fontWeight: 650,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>身份群体与阶级</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>1-7 页</div>
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <MiniButton active compact>PDF</MiniButton>
          <MiniButton compact>OCR 文本</MiniButton>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <MiniButton compact>-</MiniButton>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>100%</span>
          <MiniButton compact>+</MiniButton>
        </div>
        <div style={{ display: 'inline-flex', gap: 7 }}>
          <MiniButton active compact>OCR<br />识别</MiniButton>
          <MiniButton compact>翻译</MiniButton>
        </div>
      </div>
      <div style={{
        height: 188,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, var(--bg-warm), var(--bg))',
      }}>
        <div style={{
          width: 150,
          height: 174,
          borderRadius: 9,
          background: '#fff',
          border: '1px solid rgba(220,216,205,0.95)',
          boxShadow: '0 12px 28px rgba(60,50,30,0.10)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          gap: 8,
        }}>
          <MockLine w="64%" h={7} />
          <MockLine w="94%" />
          <MockLine w="82%" />
          <MockLine w="88%" accent />
        </div>
      </div>
    </div>
  </PreviewFrame>
)

const MarkPreview = () => (
  <PreviewFrame label="选中文字后的标记栏">
    <div style={{
      position: 'relative',
      border: '1px solid var(--border)',
      borderRadius: 9,
      background: 'var(--bg)',
      padding: '58px 18px 20px',
      minHeight: 144,
    }}>
      <div style={{
        position: 'absolute',
        top: 16,
        left: 28,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 10px',
        borderRadius: 11,
        background: 'rgba(53, 43, 32, 0.96)',
        boxShadow: '0 10px 26px rgba(40,30,20,0.24)',
      }}>
        {[
          { text: '标记', active: true },
          { text: '划线', active: false },
          { text: '高光', active: false },
        ].map(btn => (
          <span key={btn.text} style={{
            height: 32,
            minWidth: 50,
            padding: '0 12px',
            borderRadius: 8,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: btn.active ? '1px solid rgba(215, 171, 128, 0.55)' : '1px solid rgba(255,255,255,0.86)',
            background: btn.active ? 'var(--accent)' : 'rgba(255, 252, 240, 0.96)',
            color: btn.active ? '#fff' : 'rgba(74, 64, 52, 0.82)',
            fontSize: 14,
            fontWeight: 650,
            lineHeight: 1,
            boxShadow: btn.active ? 'inset 0 1px 0 rgba(255,255,255,0.18)' : 'none',
          }}>{btn.text}</span>
        ))}
        {['#FFD43B', '#FF6B6B', '#51CF66', '#339AF0', '#FF922B'].map(c => (
          <span key={c} style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: c,
            border: c === '#339AF0' ? '3px solid #fff' : '1px solid rgba(255,255,255,0.68)',
            boxShadow: c === '#339AF0' ? '0 0 0 1px rgba(80, 132, 184, 0.8)' : 'none',
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <MockLine w="96%" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MockLine w="25%" />
          <span style={{
            width: '44%',
            height: 15,
            borderRadius: 4,
            background: 'rgba(255, 212, 59, 0.42)',
            borderBottom: '2px solid #339AF0',
          }} />
          <MockLine w="18%" />
        </div>
        <MockLine w="82%" />
      </div>
    </div>
  </PreviewFrame>
)

const NotesPreview = () => (
  <PreviewFrame label="右侧注释面板">
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 172px', gap: 12 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)', padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <MockLine w="82%" />
        <MockLine w="92%" accent />
        <MockLine w="76%" />
        <div style={{ marginTop: 5, width: 118 }}>
          <MiniButton compact>点击标记编辑</MiniButton>
        </div>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)' }}>注释</div>
        <div style={{ border: '1px solid var(--border-light)', borderRadius: 7, padding: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            <span>想法</span><span>×</span>
          </div>
          <MockLine w="90%" />
        </div>
        <div style={{ border: '1px solid var(--border-light)', borderRadius: 7, padding: 8 }}>
          <MockLine w="72%" />
        </div>
      </div>
    </div>
  </PreviewFrame>
)

const DialoguePreview = () => (
  <PreviewFrame label="右侧学徒 · 对话">
    <div style={{ border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderBottom: '1px solid var(--border-light)' }}>
        <DialogueIcon />
        <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>学徒</span>
        <MiniButton compact>模型</MiniButton>
      </div>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
        <MiniTab active>对话</MiniTab>
        <MiniTab>召唤</MiniTab>
      </div>
      <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ alignSelf: 'flex-end', maxWidth: '70%', padding: '8px 11px', borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--text)', fontSize: 12 }}>这段论证在说什么？</div>
        <div style={{ alignSelf: 'flex-start', maxWidth: '78%', padding: '8px 11px', borderRadius: 10, border: '1px solid var(--border-light)', color: 'var(--text-secondary)', fontSize: 12 }}>我会结合当前书页、划线和注释来回答。</div>
        <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr 34px', gap: 8, marginTop: 2 }}>
          <MiniButton compact>召唤</MiniButton>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, height: 30, display: 'flex', alignItems: 'center', padding: '0 10px', color: 'var(--text-muted)', fontSize: 12 }}>输入问题...</div>
          <MiniButton active compact>→</MiniButton>
        </div>
      </div>
    </div>
  </PreviewFrame>
)

const SummonPreview = () => {
  const rows = [
    ['柏拉图', '古希腊 · 古典期 · 哲学家', true],
    ['孔子', '中国 · 春秋 · 思想家', true],
    ['老子', '中国 · 春秋 · 道家', true],
  ] as const

  return (
    <PreviewFrame label="右侧学徒 · 底部召唤按钮">
      <div style={{
        border: '1px solid var(--border)',
        borderRadius: 9,
        overflow: 'hidden',
        background: 'var(--bg)',
      }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
          <MiniTab active>对话</MiniTab>
          <MiniTab>召唤</MiniTab>
        </div>

        <div style={{ padding: 12, borderBottom: '1px solid var(--border-light)' }}>
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: 'color-mix(in srgb, var(--bg-warm) 88%, var(--bg) 12%)',
            boxShadow: '0 8px 24px rgba(62, 48, 28, 0.06)',
            padding: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                color: 'var(--text-muted)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" {...iconStyle}>
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>当前召唤</span>
                  <span style={{
                    fontSize: 10,
                    color: 'var(--accent-hover)',
                    background: 'var(--accent-soft)',
                    border: '1px solid var(--border-light)',
                    borderRadius: 999,
                    padding: '1px 7px',
                  }}>3 / 3</span>
                  <span style={{
                    color: 'var(--accent-hover)',
                    fontWeight: 700,
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>柏拉图 · 孔子 · 老子</span>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  选中的人物会参与下一次回答
                </div>
              </div>
              <MiniButton compact>全部取消</MiniButton>
            </div>

            <div style={{
              marginBottom: 8,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-light)',
              background: 'var(--bg)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text)' }}>辩论模式</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>关 · 每次各自独立回答一次</div>
              </div>
              <MiniButton compact>开启</MiniButton>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {rows.map(([name, desc, selected]) => (
                <div key={name} style={{
                  minHeight: 36,
                  padding: '6px 8px',
                  borderRadius: 8,
                  background: selected ? 'color-mix(in srgb, var(--accent-soft) 82%, var(--bg) 18%)' : 'transparent',
                  border: `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 48%, var(--border) 52%)' : 'transparent'}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <span style={{
                    width: 16,
                    height: 16,
                    borderRadius: 5,
                    border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                    background: selected ? 'var(--accent)' : 'var(--bg)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    {selected && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 12 10 18 20 6" />
                      </svg>
                    )}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-hover)' }}>{name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textAlign: 'center',
              marginTop: 8,
              paddingTop: 7,
              borderTop: '1px solid var(--border-light)',
            }}>
              输入 @柏拉图 可指定单人回答；不指定时按召唤席轮流回应
            </div>
          </div>
        </div>

        <div style={{ padding: '8px 12px', display: 'flex', gap: 7, alignItems: 'center' }}>
          <MiniButton active compact>柏拉图 +2</MiniButton>
          <div style={{
            flex: 1,
            minWidth: 0,
            height: 32,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg)',
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            fontSize: 12,
          }}>问所有召唤者 · 或 @柏拉图 指定...</div>
          <MiniButton active compact>↗</MiniButton>
        </div>
      </div>
    </PreviewFrame>
  )
}

const STEPS: Step[] = [
  {
    title: '导入文献',
    label: 'STEP 1',
    icon: <ImportIcon />,
    visual: <ImportPreview />,
    body: (
      <>
        从左侧 <Pill accent>文献库</Pill> 的搜索框下方开始：第一个图标导入文件，第二个图标导入文件夹。支持 PDF、EPUB、DOCX、TXT、Markdown 等常见格式，也可以直接把文件拖进窗口。
      </>
    ),
  },
  {
    title: '阅读与 OCR',
    label: 'STEP 2',
    icon: <ReaderIcon />,
    visual: <ReaderPreview />,
    body: (
      <>
        普通电子书导入后可以直接读；扫描版 PDF 点顶部工具栏的 <Pill accent>OCR 识别</Pill>。完成后可在 <Pill>PDF</Pill> 和 <Pill>OCR 文本</Pill> 间切换，缩放、翻译和字号调节都在同一条工具栏里。
      </>
    ),
  },
  {
    title: '标记与注释',
    label: 'STEP 3',
    icon: <MarkIcon />,
    visual: <MarkPreview />,
    body: (
      <>
        选中文本后会先按上次记忆的颜色生成标记，再显示设置栏。你可以切换划线、高光或颜色；再次点已标记文本可以继续编辑，写注释时用 <KBD>Ctrl</KBD> + <KBD>Enter</KBD> 保存。
      </>
    ),
  },
  {
    title: '管理注释',
    label: 'STEP 4',
    icon: <NotesIcon />,
    visual: <NotesPreview />,
    body: (
      <>
        右侧注释面板集中显示当前文献的划线、高光和注释。点击卡片会回到原文位置，点击原文里的标记可以修改属性；这些内容都保存在本地，跟随这本文献一起沉淀。
      </>
    ),
  },
  {
    title: '学徒对话',
    label: 'STEP 5',
    icon: <DialogueIcon />,
    visual: <DialoguePreview />,
    body: (
      <>
        右侧 <Pill accent>学徒</Pill> 以对话为主：它会结合当前书页、选中文本、划线和注释回答。原来的学徒周报入口已经下线，最近阅读整理和追问能力整合进学徒对话。
      </>
    ),
  },
  {
    title: '召唤人物',
    label: 'STEP 6',
    icon: <SummonIcon />,
    visual: <SummonPreview />,
    body: (
      <>
        切到 <Pill accent>召唤</Pill> 后选择已发布的 skill 人物，回到 <Pill>对话</Pill> 后底部召唤按钮会切换当前对话中的人物。1.3.3 公共社区先开放孔子、老子、墨子、苏格拉底、柏拉图、亚里士多德六位。
      </>
    ),
  },
]

export default function FeatureTourModal(): JSX.Element | null {
  const [shouldShow, setShouldShow] = useState(false)
  const [stepIdx, setStepIdx] = useState(0)
  const forceFeatureTour = useUiStore(s => s.forceFeatureTour)
  const setForceFeatureTour = useUiStore(s => s.setForceFeatureTour)

  useEffect(() => {
    let alreadyShown = false
    try { alreadyShown = !!localStorage.getItem(FLAG_KEY) } catch {}
    if (alreadyShown || !window.electronAPI?.aiGetProviders) return

    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      window.electronAPI.aiGetProviders().then((providers: any[]) => {
        if (!cancelled && providers.some(p => p.hasKey)) setShouldShow(true)
      }).catch(() => {})
    }, 1800)

    return () => { cancelled = true; clearTimeout(t) }
  }, [])

  const close = useCallback((markAsSeen: boolean) => {
    if (markAsSeen) {
      try { localStorage.setItem(FLAG_KEY, '1') } catch {}
    }
    setShouldShow(false)
    setStepIdx(0)
    if (forceFeatureTour) setForceFeatureTour(false)
  }, [forceFeatureTour, setForceFeatureTour])

  const next = useCallback(() => {
    if (stepIdx >= STEPS.length - 1) close(true)
    else setStepIdx(i => i + 1)
  }, [stepIdx, close])

  const prev = useCallback(() => {
    setStepIdx(i => Math.max(0, i - 1))
  }, [])

  useEffect(() => {
    if (!shouldShow && !forceFeatureTour) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
      else if (e.key === 'Escape') { e.preventDefault(); close(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shouldShow, forceFeatureTour, next, prev, close])

  if (!shouldShow && !forceFeatureTour) return null

  const step = STEPS[stepIdx]
  const isFirst = stepIdx === 0
  const isLast = stepIdx === STEPS.length - 1

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1001,
        background: 'rgba(40, 30, 20, 0.42)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        animation: 'sj-tour-fade 0.18s ease-out',
      }}
      onClick={() => close(true)}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(760px, calc(100vw - 40px))',
          maxHeight: 'calc(100vh - 40px)',
          overflowY: 'auto',
          background: 'var(--bg, #faf6ef)',
          borderRadius: 14,
          padding: '26px 34px 24px',
          boxShadow: '0 18px 48px rgba(40, 30, 20, 0.26)',
          border: '1px solid var(--border)',
          fontFamily: 'inherit',
          animation: 'sj-tour-pop 0.22s cubic-bezier(.2,.9,.3,1.15)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStepIdx(i)}
                title={`第 ${i + 1} 步`}
                style={{
                  width: i === stepIdx ? 22 : 7,
                  height: 7,
                  borderRadius: 999,
                  padding: 0,
                  border: 'none',
                  background: i === stepIdx ? 'var(--accent)' : i < stepIdx ? 'rgba(75,65,50,0.38)' : 'var(--border)',
                  cursor: 'pointer',
                  transition: 'width 0.18s ease, background 0.18s ease',
                }}
              />
            ))}
            <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{stepIdx + 1} / {STEPS.length}</span>
          </div>
          <button
            onClick={() => close(true)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              borderRadius: 6,
            }}
          >
            跳过
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 15, marginBottom: 18, color: 'var(--accent)' }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-warm)',
            border: '1px solid var(--border-light)',
            flexShrink: 0,
          }}>
            {step.icon}
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 4 }}>
              功能指引 · {step.label}
            </div>
            <div style={{ fontSize: 23, lineHeight: 1.2, fontWeight: 750, color: 'var(--text)' }}>
              {step.title}
            </div>
          </div>
        </div>

        {step.visual}

        <div style={{
          fontSize: 14,
          color: 'var(--text-secondary)',
          lineHeight: 1.9,
          padding: '15px 18px',
          background: 'var(--bg-warm)',
          borderRadius: 10,
          border: '1px solid var(--border-light)',
          marginBottom: 20,
        }}>
          {step.body}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '132px 1fr 132px', alignItems: 'center', gap: 12 }}>
          <button
            onClick={prev}
            disabled={isFirst}
            style={{
              height: 40,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'transparent',
              color: isFirst ? 'var(--text-muted)' : 'var(--text-secondary)',
              cursor: isFirst ? 'not-allowed' : 'pointer',
              opacity: isFirst ? 0.42 : 1,
              fontSize: 14,
            }}
          >
            ← 上一步
          </button>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12, opacity: 0.8 }}>
            <KBD>←</KBD><KBD>→</KBD><span style={{ alignSelf: 'center' }}>切换</span><KBD>Esc</KBD><span style={{ alignSelf: 'center' }}>跳过</span>
          </div>
          <button
            onClick={next}
            autoFocus
            style={{
              height: 42,
              border: 'none',
              borderRadius: 8,
              background: 'var(--accent)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            {isLast ? '完成 ✓' : '下一步 →'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes sj-tour-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes sj-tour-pop {
          from { opacity: 0; transform: translateY(-8px) scale(0.97) }
          to { opacity: 1; transform: translateY(0) scale(1) }
        }
      `}</style>
    </div>
  )
}
