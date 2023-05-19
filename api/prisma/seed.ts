import {prisma} from '../lib/providers/prisma';

const users = [
  {
    email: 'azurfluh@bitmischief.io',
  },
];

const characters = [
  {
    id: 1,
    name: 'Muad\'Dib',
  },
];

(async () => {
  for(let user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: {
        email: user.email,
      },
    });
  }

  for(let character of characters) {
    await prisma.character.upsert({
      where: { id: character.id },
      update: {},
      create: {
        ...character,
      },
    });
  }
})();