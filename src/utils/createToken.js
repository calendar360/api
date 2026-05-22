import jwt from 'jsonwebtoken';

const createToken = (userId) => {
  const secret =
    process.env.JWT_SECRET ||
    'a9597f305350a847503b7d86967d731a401ffa32ce21320f6ced2c929f143dcb2f05f23dcacabdf0ca12ce84f9e598aa6b86c8c83ce0c04bf64e585e18b03f3c';

  return jwt.sign({ id: userId }, secret, { expiresIn: '30d' });
};

export default createToken;
