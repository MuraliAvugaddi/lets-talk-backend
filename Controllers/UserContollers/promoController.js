const Promo = require("../../Models/promo");
const { uploadPromoImage, uploadPromoVideo, deleteFromCloudinary } = require("../../utils/cloudinary");

// =====================================================
// POSTERS & REELS on the student home screen
//   Admin:   POST   /api/promo            (multipart: image and/or video + title, caption, targetMode, endsAt)
//            GET    /api/promo            (all posts, newest first)
//            PATCH  /api/promo/:id        { active?, title?, caption?, targetMode?, endsAt? }
//            DELETE /api/promo/:id        (also deletes the files from Cloudinary)
//   Student: GET    /api/promo/active?mode=online|offline
// =====================================================

const MODES = ["all", "online", "offline"];
const IMAGE_MAX = 10 * 1024 * 1024; // 10 MB
const VIDEO_MAX = 100 * 1024 * 1024; // 100 MB (Cloudinary single-upload limit)

const cleanMode = (m) => (MODES.includes(String(m || "").toLowerCase()) ? String(m).toLowerCase() : "all");

const cleanEndsAt = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === "null") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const hasMedia = (m) => !!(m && m.url);

// "https://www.instagram.com/reel/DAbc123xyz/?igsh=..."  → { url, code, kind } (null = not an Instagram link)
const parseInstagram = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  const m = text.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(reels?|p|tv)\/([A-Za-z0-9_-]{5,})/i);
  if (!m) return null;
  const kind = m[1].toLowerCase().startsWith("reel") ? "reel" : m[1].toLowerCase();
  const code = m[2];
  return { url: `https://www.instagram.com/${kind}/${code}/`, code, kind };
};
const hasInstagram = (p) => !!(p && p.instagram && p.instagram.code);
const instagramView = (ig) =>
  ig && ig.code
    ? { url: ig.url, code: ig.code, kind: ig.kind, embedUrl: `https://www.instagram.com/${ig.kind || "reel"}/${ig.code}/embed/` }
    : null;

// What the student app needs (no Cloudinary ids)
const publicView = (p) => ({
  _id: p._id,
  title: p.title,
  caption: p.caption,
  image: hasMedia(p.image)
    ? { url: p.image.url, originalUrl: p.image.originalUrl, width: p.image.width, height: p.image.height }
    : null,
  video: hasMedia(p.video)
    ? {
        url: p.video.url,
        originalUrl: p.video.originalUrl,
        thumbUrl: p.video.thumbUrl,
        width: p.video.width,
        height: p.video.height,
        duration: p.video.duration,
      }
    : null,
  instagram: instagramView(p.instagram),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

// Pure (tested): is this post visible to a student of `mode` right now?
const isLive = (p, mode, now = new Date()) =>
  !!p &&
  p.active === true &&
  (hasMedia(p.image) || hasMedia(p.video) || hasInstagram(p)) &&
  (p.targetMode === "all" || p.targetMode === mode) &&
  (!p.endsAt || new Date(p.endsAt) > now);

const createPromo = async (req, res) => {
  try {
    const imageFile = req.files && req.files.image && req.files.image[0];
    const videoFile = req.files && req.files.video && req.files.video[0];
    const rawIg = String(req.body.instagramUrl || "").trim();
    const instagram = parseInstagram(rawIg);
    if (rawIg && !instagram) {
      return res.status(400).json({ message: "That is not an Instagram reel/post link. Copy it from Instagram → Share → Copy link." });
    }
    if (!imageFile && !videoFile && !instagram) {
      return res.status(400).json({ message: "Add a poster, a reel video or an Instagram link." });
    }
    if (imageFile && imageFile.size > IMAGE_MAX) {
      return res.status(400).json({ message: "Image is too large (max 10 MB)." });
    }
    if (videoFile && videoFile.size > VIDEO_MAX) {
      return res.status(400).json({ message: "Reel is too large (max 100 MB)." });
    }

    const [image, video] = await Promise.all([
      imageFile ? uploadPromoImage(imageFile.buffer) : null,
      videoFile ? uploadPromoVideo(videoFile.buffer) : null,
    ]);

    const endsAt = cleanEndsAt(req.body.endsAt);
    const promo = await Promo.create({
      title: String(req.body.title || "").slice(0, 120),
      caption: String(req.body.caption || "").slice(0, 500),
      targetMode: cleanMode(req.body.targetMode),
      image: image || {},
      video: video || {},
      instagram: instagram || {},
      active: true,
      endsAt: endsAt === undefined ? null : endsAt,
      createdBy: req.user ? req.user._id : null,
      createdByName: req.user ? req.user.name || "" : "",
    });

    if (req.io) req.io.emit("promo_updated", { id: String(promo._id) });
    res.status(201).json({ message: "Posted to students", promo });
  } catch (error) {
    console.error("Create promo error:", error);
    const msg = error && error.message ? error.message : "Upload failed";
    res.status(500).json({ message: `Upload failed: ${msg}` });
  }
};

const listPromos = async (req, res) => {
  try {
    const promos = await Promo.find({}).sort({ createdAt: -1 }).limit(100).lean();
    const now = new Date();
    res.status(200).json({
      promos: promos.map((p) => ({
        ...p,
        live: ["online", "offline"].some((m) => isLive(p, m, now)),
        ended: !!(p.endsAt && new Date(p.endsAt) <= now),
      })),
    });
  } catch (error) {
    console.error("List promos error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const updatePromo = async (req, res) => {
  try {
    const promo = await Promo.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: "Post not found" });

    const { active, title, caption, targetMode } = req.body || {};
    if (typeof active === "boolean") promo.active = active;
    if (typeof title === "string") promo.title = title.slice(0, 120);
    if (typeof caption === "string") promo.caption = caption.slice(0, 500);
    if (targetMode !== undefined) promo.targetMode = cleanMode(targetMode);
    const endsAt = cleanEndsAt((req.body || {}).endsAt);
    if (endsAt !== undefined) promo.endsAt = endsAt;

    await promo.save();
    if (req.io) req.io.emit("promo_updated", { id: String(promo._id) });
    res.status(200).json({ message: "Updated", promo });
  } catch (error) {
    console.error("Update promo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const deletePromo = async (req, res) => {
  try {
    const promo = await Promo.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: "Post not found" });
    await Promise.all([
      deleteFromCloudinary(promo.image && promo.image.publicId, "image"),
      deleteFromCloudinary(promo.video && promo.video.publicId, "video"),
    ]);
    await promo.deleteOne();
    if (req.io) req.io.emit("promo_updated", { id: String(promo._id), deleted: true });
    res.status(200).json({ message: "Deleted" });
  } catch (error) {
    console.error("Delete promo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getActivePromos = async (req, res) => {
  try {
    const mode = String(req.query.mode || "online").toLowerCase() === "offline" ? "offline" : "online";
    const now = new Date();
    const promos = await Promo.find({
      active: true,
      targetMode: { $in: ["all", mode] },
      $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
    res.status(200).json({ promos: promos.filter((p) => isLive(p, mode, now)).map(publicView) });
  } catch (error) {
    console.error("Active promos error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  _parseInstagram: parseInstagram,
  createPromo,
  listPromos,
  updatePromo,
  deletePromo,
  getActivePromos,
  _internal: { isLive, cleanMode, cleanEndsAt, publicView },
};
