const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "echocity.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    severity INTEGER NOT NULL,
    affectedPeople INTEGER NOT NULL,
    waitingHours INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Open',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function calculatePriority(issue) {
  const severityScore = issue.severity * 10;
  const impactScore = Math.min(30, Math.round(issue.affectedPeople / 10));
  const waitingScore = Math.min(20, issue.waitingHours || 0);
  const score = Math.min(100, severityScore + impactScore + waitingScore);

  let level = "Low";
  if (score >= 75) level = "Critical";
  else if (score >= 50) level = "High";
  else if (score >= 25) level = "Medium";

  return {
    score,
    level,
    explanation: [
      `Severity contributes ${severityScore} points.`,
      `Affected people contribute ${impactScore} points.`,
      `Waiting time contributes ${waitingScore} points.`,
      "Total is capped at 100 points."
    ]
  };
}

function presentIssue(row) {
  return { ...row, priority: calculatePriority(row) };
}

function distanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const lat1 = rad(a.latitude);
  const lat2 = rad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function findDuplicates(candidate, excludeId = null) {
  const rows = db.prepare(`
    SELECT * FROM issues
    WHERE category = ?
      AND status != 'Resolved'
      AND (? IS NULL OR id != ?)
  `).all(candidate.category, excludeId, excludeId);

  return rows
    .map(row => {
      const distance = distanceMeters(candidate, row);
      const sameTitle = row.title.trim().toLowerCase() === candidate.title.trim().toLowerCase();
      const sameTitleAnywhere = sameTitle && distance <= 2000;
      const closeSameCategory = distance <= 150;

      let confidence = "Low";
      if (sameTitleAnywhere || (closeSameCategory && sameTitle)) {
        confidence = "High";
      } else if (closeSameCategory) {
        confidence = "Possible";
      }

      return {
        issue: presentIssue(row),
        distanceMeters: Math.round(distance),
        confidence,
        reason: sameTitleAnywhere
          ? "The title is very similar and the report is nearby."
          : "An unresolved report in the same category is nearby."
      };
    })
    .filter(item => item.distanceMeters <= 150 || item.confidence === "High")
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "EchoCity API is running!",
    database: "SQLite connected",
    version: "1.1.0",
    features: ["priority-scoring", "duplicate-detection", "city-analytics"]
  });
});

app.get("/api/issues", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM issues
    ORDER BY
      CASE status WHEN 'Resolved' THEN 1 ELSE 0 END,
      createdAt DESC,
      id DESC
  `).all();

  res.json({
    success: true,
    count: rows.length,
    issues: rows.map(presentIssue)
  });
});

app.get("/api/issues/:id/duplicates", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, message: "Invalid issue ID." });
  }

  const row = db.prepare("SELECT * FROM issues WHERE id = ?").get(id);
  if (!row) {
    return res.status(404).json({ success: false, message: "Issue not found." });
  }

  const duplicates = findDuplicates(row, id);
  res.json({
    success: true,
    issueId: id,
    possibleDuplicateCount: duplicates.length,
    duplicates
  });
});

app.get("/api/analytics", (req, res) => {
  const rows = db.prepare("SELECT * FROM issues").all().map(presentIssue);

  const byCategory = {};
  const byStatus = { Open: 0, "In Progress": 0, Resolved: 0 };
  const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };

  let affectedPeople = 0;
  let totalPriority = 0;

  for (const issue of rows) {
    byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
    byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
    byPriority[issue.priority.level] += 1;
    affectedPeople += issue.affectedPeople;
    totalPriority += issue.priority.score;
  }

  res.json({
    success: true,
    analytics: {
      totalReports: rows.length,
      affectedPeople,
      averagePriority: rows.length ? Math.round(totalPriority / rows.length) : 0,
      resolutionRate: rows.length
        ? Math.round(byStatus.Resolved / rows.length * 100)
        : 0,
      byCategory,
      byStatus,
      byPriority
    }
  });
});

app.post("/api/issues", (req, res) => {
  const {
    title, category, description,
    latitude, longitude, severity, affectedPeople
  } = req.body || {};

  const allowedCategories = [
    "Pothole", "Water Leak", "Streetlight",
    "Garbage", "Drainage", "Other"
  ];

  if (
    typeof title !== "string" || !title.trim() || title.trim().length > 100 ||
    typeof description !== "string" || !description.trim() ||
    description.length > 2000 ||
    !allowedCategories.includes(category) ||
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    !Number.isInteger(severity) || severity < 1 || severity > 5 ||
    !Number.isInteger(affectedPeople) || affectedPeople < 0 ||
    affectedPeople > 10000000
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid issue data. Check all fields and try again."
    });
  }

  const candidate = {
    title: title.trim(),
    category,
    latitude,
    longitude
  };

  const duplicates = findDuplicates(candidate);

  const result = db.prepare(`
    INSERT INTO issues (
      title, category, description, latitude, longitude,
      severity, affectedPeople
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title.trim(), category, description.trim(),
    latitude, longitude, severity, affectedPeople
  );

  const row = db.prepare(
    "SELECT * FROM issues WHERE id = ?"
  ).get(result.lastInsertRowid);

  res.status(201).json({
    success: true,
    message: "Issue reported successfully.",
    issue: presentIssue(row),
    duplicateCheck: {
      possibleDuplicateCount: duplicates.length,
      possibleDuplicates: duplicates.slice(0, 5).map(item => ({
        id: item.issue.id,
        title: item.issue.title,
        distanceMeters: item.distanceMeters,
        confidence: item.confidence,
        reason: item.reason
      })),
      note: duplicates.length
        ? "Similar unresolved reports were found. Review them before creating another report."
        : "No nearby unresolved report in this category was found."
    }
  });
});

app.patch("/api/issues/:id/status", (req, res) => {
  const { status } = req.body || {};
  const allowed = ["Open", "In Progress", "Resolved"];

  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be Open, In Progress, or Resolved."
    });
  }

  const id = Number(req.params.id);
  const result = db.prepare(
    "UPDATE issues SET status = ? WHERE id = ?"
  ).run(status, id);

  if (!result.changes) {
    return res.status(404).json({
      success: false,
      message: "Issue not found."
    });
  }

  const row = db.prepare(
    "SELECT * FROM issues WHERE id = ?"
  ).get(id);

  res.json({ success: true, issue: presentIssue(row) });
});

app.delete("/api/issues/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare(
    "DELETE FROM issues WHERE id = ?"
  ).run(id);

  if (!result.changes) {
    return res.status(404).json({
      success: false,
      message: "Issue not found."
    });
  }

  res.json({ success: true, message: "Issue deleted successfully." });
});

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

app.listen(PORT, () => {
  console.log("==================================");
  console.log("       EchoCity API Server");
  console.log("==================================");
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`Analytics: http://localhost:${PORT}/api/analytics`);
  console.log("Features: Duplicate Detection + City Analytics");
});
