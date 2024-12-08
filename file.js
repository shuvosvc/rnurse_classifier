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
  
    // Convert to grayscale, resize, and apply enhancements
    const processedImg = original
      .grayscale()
      .resize(1024, 1024, { fit: 'inside' }) // Resize to max 1024x1024 while preserving aspect ratio
      .sharpen({ sigma: 1.2 }) // Enhance edges for better text clarity
      .modulate({ contrast: 2 }) // Increase contrast
      .toFormat('webp', { quality: 100 }); // Compress to WebP with high quality
  
    const processedImgBuffer = await processedImg.toBuffer();
  
    const resizedImages = {
      classifyImg: { buffer: processedImgBuffer, filename: `${originalFilename}-classifyImg-${currentDate}.webp` },
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
  


const deleteImagesByPaths = async (imagePaths) => {
    const baseUrlRegex = /^(https?:\/\/[^/]+\/uploads\/)/; // Match the base URL
  
    await Promise.all(
      imagePaths.map(async (imagePath) => {
        try {
          // Remove the base URL and the "uploads/" prefix from the path using regex
          const imagePathWithoutBaseUrl = imagePath.replace(baseUrlRegex, '');
  
          // Ensure the path is within the designated projectUploadPath to prevent unintended deletions
  
          const absolutePath = path.resolve(projectUploadPath, imagePathWithoutBaseUrl);
  
          if (absolutePath.startsWith(projectUploadPath)) {
            // Delete the image
            await fs.unlink(absolutePath);
          } else {
            console.warn(`Invalid path: ${imagePathWithoutBaseUrl}`);
          }
        } catch (error) {
          console.error(`Error deleting image at path: ${imagePath}`, error);
        }
      })
    );
  };



  app.delete('/api/delete',  express.json(), async (req, res) => {
    try {
      const { classifyImg } = req.body;
  
      if ( !classifyImg) {
        return res.status(400).send('Invalid request format. Ensure all four image paths are provided.');
      }
  
      // Delete images based on the provided paths
      await deleteImagesByPaths([ classifyImg]);
  
      res.status(200).send('Images deleted successfully.');
    } catch (error) {
  
      res.status(500).send('Internal Server Error');
    }
  });

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});