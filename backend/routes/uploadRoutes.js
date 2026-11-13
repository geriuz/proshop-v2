import path from 'path';
import crypto from 'crypto';
import express from 'express';
import multer from 'multer';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { protect, admin } from '../middleware/authMiddleware.js';

const router = express.Router();

// ----- Configuración de almacenamiento -----
// En Azure se usa Blob Storage con identidad administrada (sin claves en el código).
// En local, si no hay variables de Azure, se guarda en la carpeta uploads/.
const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'product-images';
const useBlob = Boolean(STORAGE_ACCOUNT);

let containerClient = null;
if (useBlob) {
  const blobService = new BlobServiceClient(
    `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );
  containerClient = blobService.getContainerClient(CONTAINER);
}

const storage = useBlob
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination(req, file, cb) {
        cb(null, 'uploads/');
      },
      filename(req, file, cb) {
        cb(null, `image-${Date.now()}${path.extname(file.originalname)}`);
      },
    });

function fileFilter(req, file, cb) {
  const filetypes = /jpe?g|png|webp/;
  const mimetypes = /image\/jpe?g|image\/png|image\/webp/;

  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = mimetypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Images only!'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // máximo 2 MB por imagen
});
const uploadSingleImage = upload.single('image');

// Solo administradores autenticados pueden subir imágenes
router.post('/', protect, admin, (req, res) => {
  uploadSingleImage(req, res, async function (err) {
    if (err) {
      return res.status(400).send({ message: err.message });
    }
    if (!req.file) {
      return res.status(400).send({ message: 'No image received' });
    }

    try {
      if (!useBlob) {
        return res.status(200).send({
          message: 'Image uploaded successfully',
          image: `/${req.file.path}`,
        });
      }

      // Nombre aleatorio: evita colisiones y no expone el nombre original
      const ext = path.extname(req.file.originalname).toLowerCase();
      const blobName = `${crypto.randomUUID()}${ext}`;
      const blockBlob = containerClient.getBlockBlobClient(blobName);

      await blockBlob.uploadData(req.file.buffer, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype },
      });

      res.status(200).send({
        message: 'Image uploaded successfully',
        image: blockBlob.url,
      });
    } catch (error) {
      console.error('Blob upload error:', error.message);
      res.status(500).send({ message: 'Error uploading image' });
    }
  });
});

export default router;
