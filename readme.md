# GeoTrack

A self-hosted location-tracking link platform. Create short-lived tracking links, share them with anyone, and see exactly where they were opened — GPS coordinates, device type, browser, and IP address — all visualised on an interactive map.

![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-47A248?logo=mongodb&logoColor=white)
![Version](https://img.shields.io/badge/version-2.0.1-blue)

---

## How It Works

1. **Sign up / Log in** — create an account (protected by a canvas-rendered math CAPTCHA).
2. **Create a tracking link** — paste any destination URL and choose an expiry window (1–24 hours). GeoTrack generates a `/go/:id` link.
3. **Share the link** — send it to whoever you want to locate.
4. **Target opens the link** — the landing page silently requests GPS permission, records the result, then redirects to the real destination.
5. **View hits on the dashboard** — each hit shows GPS coordinates, accuracy, device, browser, IP, and timestamp, plotted on a Leaflet map.

---

## Features

- **Expiring links** — links auto-expire between 1 and 24 hours after creation
- **Geolocation capture** — latitude, longitude, and accuracy (metres) via the browser Geolocation API
- **Device & browser detection** — iPhone, iPad, Android, Windows, Mac, Linux / Chrome, Firefox, Safari, Edge, Opera
- **IP logging** — supports proxied deployments (reads `X-Forwarded-For`)
- **Interactive map** — Leaflet.js map with hit markers on the dashboard
- **Canvas CAPTCHA** — server-side math CAPTCHA rendered with `@napi-rs/canvas`, no third-party service needed
- **Persistent sessions** — sessions stored in MongoDB, survive server restarts
- **Rate limiting** — separate limiters for auth routes, general API calls, and hit recording
- **Security headers** — via Helmet; timing-safe login (dummy hash comparison)
- **Health endpoint** — `GET /healthz` for uptime monitors

---

## Tech Stack

| Layer      | Technology                              |
|------------|-----------------------------------------|
| Runtime    | Node.js                                 |
| Framework  | Express 4                               |
| Database   | MongoDB (Mongoose 8)                    |
| Sessions   | express-session + connect-mongo         |
| Auth       | bcryptjs (cost factor 12)               |
| CAPTCHA    | @napi-rs/canvas (server-rendered PNG)   |
| Map        | Leaflet.js (CDN, dashboard only)        |
| Security   | Helmet, express-rate-limit              |
| Deployment | Railway (Procfile)                      |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- A **MongoDB** database — free tier at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) works fine

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/geotrack.git
cd geotrack

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env with your values (see below)

# 4. Start the server
npm start
```

The app will be available at `http://localhost:3000`.

### Environment Variables

Create a `.env` file in the project root:

```env
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/<dbname>
SESSION_SECRET=a_long_random_secret_string_here
PORT=3000
NODE_ENV=production
```

| Variable         | Required | Description                                    |
|------------------|----------|------------------------------------------------|
| `MONGO_URI`      | ✅        | MongoDB connection string                      |
| `SESSION_SECRET` | ✅        | Secret used to sign session cookies            |
| `PORT`           | ❌        | Server port (default: `3000`)                  |
| `NODE_ENV`       | ❌        | Set to `production` to enable secure cookies   |

---

## Project Structure

```
geotrack/
├── server.js              # Express app — all routes, schemas, and middleware
├── package.json
├── Procfile               # Railway deployment: web: node server.js
└── public/
    ├── index.html         # Login / Sign-up page
    ├── dashboard.html     # Authenticated dashboard (links + Leaflet map)
    ├── landing.html       # Tracking page shown to link targets
    ├── expired.html       # Shown when a link has expired
    └── donate.html        # Donation page
```

---

## API Reference

### Auth

| Method | Path           | Auth | Description                    |
|--------|----------------|------|--------------------------------|
| GET    | `/api/captcha` | —    | Returns a CAPTCHA PNG image    |
| POST   | `/api/signup`  | —    | Register a new user            |
| POST   | `/api/login`   | —    | Log in                         |
| POST   | `/api/logout`  | ✅   | Log out and destroy session    |
| GET    | `/api/me`      | —    | Returns current session info   |

### Links

| Method | Path                  | Auth | Description                         |
|--------|-----------------------|------|-------------------------------------|
| POST   | `/api/links/create`   | ✅   | Create a new tracking link          |
| GET    | `/api/links`          | ✅   | List all links for the current user |
| GET    | `/api/links/:id/hits` | ✅   | Get all hits for a link             |
| DELETE | `/api/links/:id`      | ✅   | Delete a link                       |

**POST `/api/links/create` body:**
```json
{
  "dest": "https://example.com",
  "expiresIn": 6
}
```
`expiresIn` is in hours, clamped to `1–24`.

### Tracking

| Method | Path            | Auth | Description                                  |
|--------|-----------------|------|----------------------------------------------|
| GET    | `/go/:id`       | —    | Visit a tracking link (serves landing page)  |
| GET    | `/api/hits/:id` | —    | Validate link and return destination URL     |
| POST   | `/api/hit/:id`  | —    | Record a hit (location, device, browser, IP) |

**POST `/api/hit/:id` body:**
```json
{
  "lat": 28.6139,
  "lon": 77.2090,
  "acc": 15
}
```

### Other

| Method | Path       | Description   |
|--------|------------|---------------|
| GET    | `/healthz` | Health check  |

---

## Deployment on Railway

The project includes a `Procfile` and is ready to deploy on [Railway](https://railway.app).

1. Push the repo to GitHub.
2. Create a new Railway project → **Deploy from GitHub repo**.
3. Add environment variables (`MONGO_URI`, `SESSION_SECRET`, `NODE_ENV=production`) under **Variables** in the Railway dashboard.
4. Railway auto-detects the `Procfile` and runs `node server.js`.

---

## Security Notes

- Passwords are hashed with **bcrypt** at cost factor 12.
- Login uses a **timing-safe** dummy hash comparison to prevent user enumeration.
- Sessions are **regenerated on login** to prevent session fixation attacks.
- Cookies are `httpOnly`, `sameSite: none`, and `secure` in production.
- Auth routes: **20 requests / 15 minutes** per IP.
- API routes: **60 requests / minute** per IP.
- Hit recording: **10 requests / minute** per link per IP.

> ⚠️ **Never commit your `.env` file.** Confirm `.env` is listed in `.gitignore`. If credentials were accidentally pushed, rotate your MongoDB password and generate a new `SESSION_SECRET` immediately.

---

## License

This project is open source and available under the [MIT License](LICENSE).