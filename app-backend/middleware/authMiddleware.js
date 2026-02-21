import jwt from 'jsonwebtoken';

const protect = (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];

      // Decode token to get user info
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Attach user ID from token to the request object
      // This userId will be available in req.user.userId in your photo upload route
      req.user = { userId: decoded.userId }; 
      next();
    } catch (error) {
      console.error('Token verification failed:', error);
      res.status(401).json({ message: 'Not authorized, token failed.' });
    }
  }

  if (!token) {
    res.status(401).json({ message: 'Not authorized, no token.' });
  }
};

export { protect };
