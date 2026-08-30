# Sentinel Tactical Operations Console (Frontend)

**Team:** BlackBox

Tactical web console for Sentinel emergency intelligence, featuring a lightweight Canvas 2D rotating globe signal acquisition intro, Leaflet "Incident Field" animated convergence vectors, live telemetry Signal Stream, Evidence Convergence Timeline, and human-in-the-loop dispatch authorization gateway.

---

## Local Development Setup

### Prerequisites
- **Node.js:** `>= 22.0.0`
- **pnpm:** `>= 11.0.0`
- Running Sentinel Backend (default: `http://localhost:3001`)

### 1. Install Dependencies
From the `frontend` folder:
```bash
cd frontend
pnpm install
```

### 2. Environment Configuration (Optional)
By default, the Vite dev server automatically proxies API requests (`/incidents`, `/reports`, `/status`) directly to `http://localhost:3001`.

If you need custom credentials or a remote backend URL, create a `.env` file in the `frontend` directory:
```env
# Leave blank to use Vite local proxy, or set to your deployed backend URL
VITE_API_BASE=""

# Operator authentication key (must match OPERATOR_API_KEY in backend)
VITE_OPERATOR_API_KEY="sentinel-tactical-secret-key"

# Operator name for audit trail
VITE_OPERATOR_NAME="duty_operator"
```

### 3. Start Local Development Server
```bash
pnpm run dev
```
The console will start at:
👉 **`http://localhost:5173`**

### 4. Build for Production
To test the production build:
```bash
pnpm run build
pnpm run preview
```

---

## Key Features & Controls
- **Canvas 2D Globe Intro:** Renders on initial boot to lock onto active telemetry coordinates. Can be replayed at any time using the `🌐 ACQUIRE` button in the map HUD.
- **Incident Field Convergence:** Click any incident from the sidebar to view animated dashed convergence lines flowing inward from field reports to the incident centroid.
- **Signal Stream:** Switch to the `Signal Stream` tab to monitor incoming telemetry feeds, or click `+ Telemetry` to simulate field reports and coordinate pinning.
- **Human Decision Gateway:** When an incident has an active AI recommendation (`PENDING_APPROVAL`), review the evidence timeline in the drawer and click `✓ APPROVE DISPATCH` or `✕ REJECT / STAND DOWN`.
