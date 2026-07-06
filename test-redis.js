const Redis = require('ioredis');
const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: 1
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
  process.exit(1);
});

async function main() {
  try {
    console.log('Connecting to redis...');
    await redis.set('test_key', 'hello');
    const val = await redis.get('test_key');
    console.log('Value:', val);
    process.exit(0);
  } catch (err) {
    console.error('Caught error:', err);
    process.exit(1);
  }
}

main();
