# ⚡ LinkPulse Studio

**Short links. Smart protection. Clear insights.**

LinkPulse Studio is a modern URL shortener built with Node.js and Express. Create short links, protect them with passwords, generate QR codes, set click limits and expiry dates, and track link analytics.

## ✨ Features

- 🔗 URL shortening
- 🎯 Custom aliases
- 🔒 Password-protected links
- 📊 Click analytics dashboard
- 📱 QR code generation and download
- ⏳ Link expiry settings
- 🚦 Maximum click limits
- ⏸️ Pause and resume links
- 📱 Responsive interface
- 🛡️ Password hashing, input validation, and rate limiting

## 🛠️ Tech Stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express.js
- **Database:** SQLite
- **Security:** bcryptjs, Helmet, express-rate-limit
- **QR Codes:** qrcode
- **Deployment:** Render

## 📁 Project Structure

```text
0-1-linkpulse/
├── server.js
├── package.json
├── package-lock.json
├── render.yaml
├── .node-version
├── database/
│   └── database.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── test/
│   └── app.test.js
├── data/
└── README.md
```

## 🚀 Run Locally

**Requirements:** Node.js 22.13 or newer and npm.

1. Clone the repository:

   ```bash
   git clone https://github.com/dikshitjoshi07/0-1-linkpulse.git
   ```

2. Open the project directory:

   ```bash
   cd 0-1-linkpulse
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the application:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000` in your browser.

### Run Tests

```bash
npm test
```

## 🌐 Deploy on Render

1. Push the project to GitHub.
2. Open [Render](https://render.com/).
3. Create a new Web Service and connect this repository.
4. Set the following commands:

   **Build Command**
   ```bash
   npm install
   ```

   **Start Command**
   ```bash
   npm start
   ```

5. Configure a compatible Node.js version.
6. Configure persistent storage for SQLite if data must survive restarts and deployments.
7. Deploy and open your Render URL.

**Note:** Render's free instances do not provide persistent local storage. Persistent disks may require a paid plan.

## 🔐 Password-Protected Links

1. A visitor opens a protected short link.
2. A password form appears.
3. The server verifies the password.
4. An incorrect password displays an error.
5. A correct password redirects to the **original destination URL**, not the shortener homepage.
6. Successful visits are recorded in analytics.

## ⚙️ Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port; defaults to `3000` |
| `BASE_URL` | Optional public URL for short links and QR codes |
| `DB_PATH` | Optional SQLite database path |
| `NODE_ENV` | Application environment |

## 🛡️ Security

- Passwords are stored as hashes, not plaintext.
- Destination URLs are validated.
- Rate limiting helps prevent password-guessing attempts.
- Security headers help protect visitors.
- Dashboard authentication should be added before exposing link-management controls publicly.

## ✅ Testing Checklist

Before considering the project ready, verify:

- [ ] Homepage loads successfully.
- [ ] Normal links redirect to the correct destination.
- [ ] Correct passwords redirect to the original destination.
- [ ] Incorrect passwords display an error.
- [ ] Click counts increment only once per successful visit.
- [ ] Expired, paused, and limit-reached links are blocked.
- [ ] QR codes contain the correct short URL.
- [ ] Database persistence works as configured.

## 👨‍💻 Author

**Dikshit Joshi**

- GitHub: [@dikshitjoshi07](https://github.com/dikshitjoshi07)
- Repository: [0-1-linkpulse](https://github.com/dikshitjoshi07/0-1-linkpulse)

## 📄 License

Add an MIT `LICENSE` file to the repository if you want to distribute this project under the MIT License.
