import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Rorca — AI Spec Orchestration';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          background: 'linear-gradient(135deg, #09090b 0%, #0d0d14 50%, #09090b 100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Glow background */}
        <div
          style={{
            position: 'absolute',
            top: '-100px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '800px',
            height: '400px',
            background: 'radial-gradient(ellipse, rgba(139, 92, 246, 0.15) 0%, transparent 70%)',
          }}
        />

        {/* Logo mark */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '32px',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
              borderRadius: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              fontWeight: 700,
              color: 'white',
            }}
          >
            R
          </div>
          <span
            style={{
              fontSize: '40px',
              fontWeight: 700,
              color: '#fafafa',
              letterSpacing: '-0.02em',
            }}
          >
            Rorca
          </span>
        </div>

        {/* Headline */}
        <div
          style={{
            fontSize: '56px',
            fontWeight: 700,
            color: '#fafafa',
            textAlign: 'center',
            lineHeight: 1.15,
            letterSpacing: '-0.03em',
            maxWidth: '900px',
            marginBottom: '24px',
          }}
        >
          AI Spec Orchestration
        </div>

        {/* Subline */}
        <div
          style={{
            fontSize: '26px',
            color: 'rgba(250, 250, 250, 0.55)',
            textAlign: 'center',
            maxWidth: '700px',
            lineHeight: 1.4,
          }}
        >
          Turn a plain-English brief into shipped code — autonomously.
        </div>

        {/* Domain badge */}
        <div
          style={{
            position: 'absolute',
            bottom: '40px',
            fontSize: '18px',
            color: 'rgba(250, 250, 250, 0.35)',
            letterSpacing: '0.02em',
          }}
        >
          rorca.app
        </div>
      </div>
    ),
    { ...size }
  );
}
