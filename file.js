const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const app = express();

require('dotenv').config();
const port = process.env.PORT || 7000;

const storage = multer.memoryStorage(); // Use memory storage to get the file buffer

const projectUploadPath = path.join(__dirname, 'uploads'); // Assuming 'uploads' is the folder within your project

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(projectUploadPath));


const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Allow only JPEG, PNG, or WebP files
    const allowedTypes = /jpeg|jpg|png|webp/;
    const fileExt = file.originalname.split('.').pop().toLowerCase();
    const isValidType = allowedTypes.test(fileExt);
    if (isValidType) {
      return cb(null, true);
    } else {
      return cb(new Error('Invalid file type. Only JPEG, PNG, or WebP allowed.'));
    }
  }
});

const generateResizedImages = async (fileBuffer, originalFilename) => {
  const currentDate = new Date().toISOString().replace(/[-:]/g, ''); // Format: YYYYMMDDTHHMMSS
  const original = sharp(fileBuffer);
  const classifyImg = original.clone().resize(32, 32);

  const [classifyImgBuffer] = await Promise.all([
    classifyImg.toFormat('webp', { quality: 50 }).toBuffer(),
  ]);

  const resizedImages = {

    classifyImg: { buffer: classifyImgBuffer, filename: `${originalFilename}-classifyImg-${currentDate}.webp` },
  };

  return resizedImages;
};

const uploadToProjectFolder = async (resizedImages) => {
  const projectUploadPath = path.join(__dirname, 'uploads'); // Assuming 'uploads' is the folder within your project

  await Promise.all(
    Object.values(resizedImages).map(async (image) => {
      const filePath = path.join(projectUploadPath, image.filename);
      await fs.writeFile(filePath, image.buffer);
    })
  );
};










app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    const originalFilename = req.file.originalname.split('.')[0];
    const resizedImages = await generateResizedImages(req.file.buffer, originalFilename);

    // Upload resized images to the project folder
    await uploadToProjectFolder(resizedImages);

    // Construct URLs based on the assumed project upload path
    const baseUrl = process.env.baseUrl || `http://localhost:${port}/uploads`; // Replace with your actual domain
    const imageUrls = {

      classifyImg: `${baseUrl}/${resizedImages.classifyImg.filename}`,
    };




    res.json(imageUrls);
  } catch (error) {
    console.error('Error processing/uploading image:', error);
    res.status(500).send('Internal Server Error');
  }
});






app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});