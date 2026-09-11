import { SignJWT, jwtVerify } from 'jose'

const secretKey = process.env.JWT_SECRET || 'super-secret-arni-key-change-in-production'
const key = new TextEncoder().encode(secretKey)

export async function encryptJWT(payload: any) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d') // Sessions last for 30 days
    .sign(key)
}

export async function decryptJWT(input: string): Promise<any> {
  const { payload } = await jwtVerify(input, key, {
    algorithms: ['HS256'],
  })
  return payload
}
