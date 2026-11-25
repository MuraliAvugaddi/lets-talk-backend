const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Fee screenshots (unchanged)
const uploadBufferToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    let uploadStream = cloudinary.uploader.upload_stream(
      { folder: "lets_talk_fees" },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// ---------------------------------------------------------------------
// Posters & reels for the student home screen
// ---------------------------------------------------------------------
const PROMO_FOLDER = "lets_talk_promos";

// Phones play H.264 MP4 everywhere (iPhone reels are often HEVC) — max 720p to save data.
const VIDEO_PLAYBACK = { video_codec: "h264", quality: "auto", width: 720, crop: "limit" };
const IMAGE_DISPLAY = { quality: "auto", width: 1080, crop: "limit" };

const uploadStream = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (result) resolve(result);
      else reject(error || new Error("Cloudinary upload failed"));
    });
    streamifier.createReadStream(buffer).pipe(stream);
  });

const uploadPromoImage = async (buffer) => {
  const r = await uploadStream(buffer, { folder: PROMO_FOLDER, resource_type: "image", timeout: 120000 });
  return {
    url: cloudinary.url(r.public_id, { secure: true, version: r.version, transformation: [IMAGE_DISPLAY] }),
    originalUrl: r.secure_url,
    publicId: r.public_id,
    width: r.width || 0,
    height: r.height || 0,
    bytes: r.bytes || 0,
  };
};

const uploadPromoVideo = async (buffer) => {
  const r = await uploadStream(buffer, {
    folder: PROMO_FOLDER,
    resource_type: "video",
    eager: [{ ...VIDEO_PLAYBACK, format: "mp4" }],
    eager_async: true, // the playback copy is prepared in the background
    timeout: 600000,
  });
  return {
    url: cloudinary.url(r.public_id, {
      resource_type: "video",
      secure: true,
      format: "mp4",
      transformation: [VIDEO_PLAYBACK],
    }),
    originalUrl: r.secure_url,
    thumbUrl: cloudinary.url(r.public_id, {
      resource_type: "video",
      secure: true,
      format: "jpg",
      transformation: [{ start_offset: "1", width: 720, crop: "limit" }],
    }),
    publicId: r.public_id,
    width: r.width || 0,
    height: r.height || 0,
    duration: Math.round(r.duration || 0),
    bytes: r.bytes || 0,
  };
};

const deleteFromCloudinary = async (publicId, resourceType = "image") => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (err) {
    console.warn(`⚠️ Cloudinary delete failed for ${publicId}: ${err.message}`);
  }
};

// 🖼 Profile photos: square 400×400, face in the middle
const uploadProfilePhoto = (buffer) =>
  uploadStream(buffer, {
    folder: "lets_talk_profiles",
    resource_type: "image",
    transformation: [{ width: 400, height: 400, crop: "fill", gravity: "face", quality: "auto", fetch_format: "auto" }],
  });

// 📚 Study material PDF (kept exactly as uploaded — "raw" file)
const uploadMaterialPdf = async (buffer, name) => {
  const r = await uploadStream(buffer, {
    folder: "lets_talk_materials",
    resource_type: "raw",
    public_id: `${name}_${Date.now()}.pdf`, // raw files keep the extension in the id
    timeout: 300000,
  });
  return { url: r.secure_url, publicId: r.public_id, bytes: r.bytes || buffer.length };
};

// 🔐 Signed download link for a material PDF.
// New Cloudinary accounts BLOCK normal PDF links (HTTP 401 "PDF delivery").
// This link goes through Cloudinary's signed download API instead, so it works
// even when PDF delivery is blocked. Valid for 12 hours (the app asks again).
const materialDownloadUrl = (publicId, hours = 12) => {
  if (!publicId) return "";
  return cloudinary.utils.private_download_url(publicId, "", {
    resource_type: "raw",
    type: "upload",
    expires_at: Math.floor(Date.now() / 1000) + hours * 3600,
  });
};

module.exports = {
  materialDownloadUrl,
  uploadBufferToCloudinary,
  uploadPromoImage,
  uploadPromoVideo,
  deleteFromCloudinary,
  uploadProfilePhoto,
  uploadMaterialPdf,
};
