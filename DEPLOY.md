# Deploying the Daily Dispatch Quiz to Railway
## Your quiz will be live at a permanent URL in about 10 minutes.

---

## What you need
- The three files: `news-quiz.html`, `server.js`, `package.json`
- A free GitHub account (github.com)
- A free Railway account (railway.app)
- Your Anthropic API key (console.anthropic.com — free to create, pay per use)

---

## Step 1 — Put your files on GitHub

GitHub is where Railway pulls your code from. You only do this once.

1. Go to **github.com** and sign in (or create a free account)
2. Click the **+** button in the top right → **New repository**
3. Name it `daily-dispatch-quiz`
4. Set it to **Private** (so your code isn't public)
5. Click **Create repository**
6. On the next page, click **uploading an existing file**
7. Drag and drop all three files:
   - `news-quiz.html`
   - `server.js`
   - `package.json`
8. Click **Commit changes**

Your files are now on GitHub.

---

## Step 2 — Deploy on Railway

1. Go to **railway.app** and click **Start a New Project**
2. Sign in with your GitHub account when prompted
3. Click **Deploy from GitHub repo**
4. Select your `daily-dispatch-quiz` repository
5. Railway will detect it's a Node.js app and start deploying automatically

---

## Step 3 — Add your Anthropic API key

This is the one secret Railway needs to call Claude on your behalf.

1. In your Railway project, click on your service (the box that appeared)
2. Click the **Variables** tab
3. Click **New Variable**
4. Set the name to: `ANTHROPIC_API_KEY`
5. Set the value to your key: `sk-ant-api03-...`
   (Get yours at console.anthropic.com → API Keys → Create Key)
6. Click **Add**
7. Railway will automatically redeploy with the key set

---

## Step 4 — Get your permanent URL

1. In Railway, click the **Settings** tab on your service
2. Under **Networking**, click **Generate Domain**
3. Railway gives you a URL like:
   `https://daily-dispatch-quiz-production.up.railway.app`

That's your live quiz! Share it with anyone.

**Bookmark these two URLs:**
- **Players:** `https://your-app.up.railway.app/news-quiz.html`
- **Admin:** Same URL — click "Admin" in the top right corner (password: newsadmin2024)

---

## Your daily routine (takes 2 minutes)

Every morning:
1. Open your admin URL
2. Click **Admin** → enter password
3. Your Baltimore news sites are already filled in (you saved them once)
4. Click **Generate Questions**
5. Review the 11 questions
6. Click **Publish**
7. Players can now play today's quiz

---

## Updating the quiz in future

If you ever need to update the HTML or server code:
1. Go to your GitHub repository
2. Click on the file you want to update
3. Click the pencil (edit) icon
4. Make your changes and click **Commit changes**
5. Railway automatically detects the change and redeploys in about 60 seconds

---

## Costs

- **Railway:** Free tier includes $5/month of usage credit, which is more than enough for this app
- **Anthropic API:** Roughly $0.01–0.03 per quiz generation (Claude Sonnet pricing)
  - Generating one quiz per day costs about $0.30–$0.90/month total

---

## Changing the city name

To use this in another city, just edit line ~963 in `news-quiz.html`:
Change `Baltimore` to your city name, update the news site URLs in the admin panel, and redeploy.
