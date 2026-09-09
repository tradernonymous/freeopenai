import os

DEFS = """  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#050816"/>
      <stop offset="0.55" stop-color="#0b1030"/>
      <stop offset="1" stop-color="#1a0b3a"/>
    </linearGradient>
    <linearGradient id="neon" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee">
        <animate attributeName="stop-color" values="#22d3ee;#a78bfa;#22d3ee" dur="9s" repeatCount="indefinite"/>
      </stop>
      <stop offset="0.5" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#f472b6">
        <animate attributeName="stop-color" values="#f472b6;#22d3ee;#f472b6" dur="9s" repeatCount="indefinite"/>
      </stop>
    </linearGradient>
    <radialGradient id="glowCyan" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowPink" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#f472b6" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#f472b6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>"""

BANNER_TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="90" viewBox="0 0 1200 90" role="img" aria-label="{label}">
  <title>{label}</title>
{defs}

  <rect x="1" y="1" width="1198" height="88" rx="22" fill="url(#bg)" stroke="url(#neon)" stroke-width="1.5"/>
  <ellipse cx="90" cy="45" rx="160" ry="70" fill="url(#glowCyan)" opacity="0.7"/>
  <ellipse cx="1120" cy="45" rx="180" ry="70" fill="url(#glowPink)" opacity="0.5"/>
{icon}
  <text x="96" y="58" font-family="Segoe UI, Inter, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="0.5" fill="url(#neon)" filter="url(#softGlow)">{title}</text>
  <rect x="0" y="0" width="220" height="90" fill="url(#sweep)">
    <animate attributeName="x" values="-220;1200" dur="6s" repeatCount="indefinite"/>
  </rect>
</svg>
"""

ICONS = {
    "features": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <path d="M22 2 L25 19 L42 22 L25 25 L22 42 L19 25 L2 22 L19 19 Z" fill="url(#neon)"/>
  </g>''',
    "models": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <rect x="10" y="10" width="24" height="24" rx="4" fill="url(#neon)"/>
    <rect x="17" y="17" width="10" height="10" rx="2" fill="#050816"/>
    <line x1="22" y1="1" x2="22" y2="10" stroke="url(#neon)" stroke-width="3"/>
    <line x1="22" y1="34" x2="22" y2="43" stroke="url(#neon)" stroke-width="3"/>
    <line x1="1" y1="22" x2="10" y2="22" stroke="url(#neon)" stroke-width="3"/>
    <line x1="34" y1="22" x2="43" y2="22" stroke="url(#neon)" stroke-width="3"/>
  </g>''',
    "usage": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <rect x="2" y="10" width="40" height="24" rx="5" fill="url(#neon)" opacity="0.92"/>
    <rect x="9" y="16" width="6" height="6" rx="1" fill="#050816"/>
    <rect x="19" y="16" width="6" height="6" rx="1" fill="#050816"/>
    <rect x="29" y="16" width="6" height="6" rx="1" fill="#050816"/>
    <rect x="9" y="25" width="26" height="4" rx="2" fill="#050816"/>
  </g>''',
    "quickstart": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <path d="M22 2 C30 8 33 20 30 30 L14 30 C11 20 14 8 22 2 Z" fill="url(#neon)"/>
    <path d="M14 24 L5 33 L14 33 Z" fill="url(#neon)" opacity="0.7"/>
    <path d="M30 24 L39 33 L30 33 Z" fill="url(#neon)" opacity="0.7"/>
    <circle cx="22" cy="15" r="4" fill="#050816"/>
  </g>''',
    "config": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <circle cx="22" cy="22" r="8" fill="none" stroke="url(#neon)" stroke-width="4"/>
    <circle cx="22" cy="22" r="3" fill="url(#neon)"/>
    <g stroke="url(#neon)" stroke-width="4" stroke-linecap="round">
      <line x1="22" y1="2" x2="22" y2="10"/>
      <line x1="22" y1="34" x2="22" y2="42"/>
      <line x1="2" y1="22" x2="10" y2="22"/>
      <line x1="34" y1="22" x2="42" y2="22"/>
      <line x1="8" y1="8" x2="13" y2="13"/>
      <line x1="31" y1="31" x2="36" y2="36"/>
      <line x1="8" y1="36" x2="13" y2="31"/>
      <line x1="31" y1="13" x2="36" y2="8"/>
    </g>
  </g>''',
    "deploy": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <path d="M14 28 a8 8 0 0 1 0 -16 a10 10 0 0 1 19 3 a7 7 0 0 1 -2 13 Z" fill="url(#neon)" opacity="0.92"/>
    <path d="M22 33 L22 17 M15 24 L22 16 L29 24" fill="none" stroke="#050816" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>''',
    "architecture": '''  <g transform="translate(34,23)" filter="url(#softGlow)">
    <polygon points="22,2 40,12 22,22 4,12" fill="url(#neon)" opacity="0.92"/>
    <polygon points="4,20 22,30 40,20" fill="none" stroke="url(#neon)" stroke-width="3"/>
    <polygon points="4,28 22,38 40,28" fill="none" stroke="url(#neon)" stroke-width="3" opacity="0.6"/>
  </g>''',
}

TITLES = {
    "features": "Features",
    "models": "Models",
    "usage": "Using the app",
    "quickstart": "Quick start",
    "config": "Configuration",
    "deploy": "Deploy to Railway",
    "architecture": "Architecture",
}

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "readme")
for key, title in TITLES.items():
    content = BANNER_TEMPLATE.format(label=title, defs=DEFS, icon=ICONS[key], title=title)
    with open(os.path.join(out_dir, f"banner-{key}.svg"), "w", encoding="utf-8", newline="\n") as f:
        f.write(content)

print("wrote", len(TITLES), "banners")
