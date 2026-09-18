  const LiveLink = require("../../Models/liveLink");

  // --- ADMIN: Upload or Update Link ---
  const updateLink = async (req, res) => {
    try {
      const { language, stage, type, link } = req.body;

      // Upsert: Update if exists, Create if new
  const liveSession = await LiveLink.findOneAndUpdate(
    { language, stage, type },
    { link, isActive: true },
    { returnDocument: 'after', upsert: true } // ✅ Modern syntax
  );

      res.json({ message: "Link updated successfully", data: liveSession });
    } catch (error) {
      console.error("Update Link Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  };

  // --- ADMIN: Delete Link ---
  const deleteLink = async (req, res) => {
    try {
      const { language, stage, type } = req.body;
      await LiveLink.findOneAndDelete({ language, stage, type });
      res.json({ message: "Link deleted successfully" });
    } catch (error) {
      console.error("Delete Link Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  };

  // --- USER: Get Link ---
  const getLink = async (req, res) => {
    try {
      const { language, stage, type } = req.query;
      
      // DEBUG LOG: See what the app is requesting
      console.log(`User requested: Lang=${language}, Stage=${stage}, Type=${type}`);

      const session = await LiveLink.findOne({ language, stage, type });

      if (!session || !session.isActive) {
        return res.status(404).json({ message: "No session active" });
      }

      res.json(session);
    } catch (error) {
      console.error("Get Link Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  };

  module.exports = { updateLink, deleteLink, getLink };