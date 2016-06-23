import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import discord from 'discord.js';
import { ConfigurationError } from './errors';
import { validateChannelMapping } from './validators';
import os from 'os';

const REQUIRED_FIELDS = ['server', 'port', 'nickname', 'channelMapping', 'discordEmail', 'discordPassword'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client();
    this.discord.autoReconnect = true;

    this.server = options.server;
    this.port = options.port;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordEmail = options.discordEmail;
    this.discordPassword = options.discordPassword;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.channels = _.values(options.channelMapping);

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    process.stdout.write('Connecting to IRC and Discord' + os.EOL);
    this.discord.login(this.discordEmail, this.discordPassword);

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      ...this.ircOptions
    };

    process.stdout.write('Server : ' + this.server + '/' + this.port + os.EOL);
    process.stdout.write('Channel : ' + this.channels[0] + os.EOL);
    process.stdout.write('Nick : ' + this.nickname + os.EOL);

    this.ircClient = new irc.Client(this.server, this.port, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      process.stdout.write('Connected to Discord' + os.EOL);
    });

    this.discord.on('disconnected', () => {
	this.discord.login(this.discordEmail, this.discordPassword);
    });

    this.ircClient.on('registered', message => {
      process.stdout.write('Registered event: ' + message.args[1] + os.EOL);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
	
      this.ircClient.join(this.channels[0]);
    });

    this.ircClient.on('error', error => {
      process.stdout.write('Received error event from IRC' + os.EOL);

      error.args.forEach(function(mesg) {
          process.stdout.write('-> ' + mesg + os.EOL);
      });
    });

    /*
    this.discord.on('presence', (oldUser, renameUser) => {
	var userName = renameUser.username;
	var statusIndicator = 'online';
	var statusString = '';
	
	if(oldUser.username != renameUser.username) {
		statusIndicator = 'change name';
	}
	else {
		statusIndicator = renameUser.status;
	}

	switch(statusIndicator) {
		case 'offline' :
			statusString = 'SIGN OFF';
			break;
		case 'idle' :
			statusString = 'IDLE IN';
			break;
		case 'change name' :
			statusString = oldUser.username + ' nick changed in ' + userName;
		default :
			statusString = 'SIGN ON';
			break;
	}

	var mesg = `<<< ${statusString} DISCORD : ${userName} >>>`;

	process.stdout.write('DISCORD STATUS CHANGE : ' + mesg + os.EOL);	

	this.sendToIRC(mesg, true);
    });
    */

    this.discord.on('error', error => {
      process.stdout.write('Received error event from Discord' + os.EOL);
    });

    this.discord.on('message', message => {
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('usernames', (author, to, users) => {
	var userlist = 'IRC IN ' + to + ' : ';

	users.forEach(function(user) {
	    userlist += user.replace('@', '*') + ', ';
	});

	userlist = userlist.substring(0, userlist.length - 2);
	userlist += ' - TOTAL : ' + users.length;

	this.sendToDiscord(author, to, userlist);
    });

    this.ircClient.on('join', (channel, nickname) => {
	this.sendToDiscord(this.nickname, channel, 'SIGN ON IRC : ' + nickname);
    });

    this.ircClient.on('part', (channel, nickname) => {
	this.sendToDiscord(this.nickname, channel, 'SIGN OFF IRC : ' + nickname);
    });

    this.ircClient.on('quit', (nick, reason, channel) => {
	this.sendToDiscord(this.nickname, channel[0], 'QUIT SERVER : ' + nick + ' / ' + reason);
    });

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      process.stdout.write('Received invite : ' + channel + " < " + from + os.EOL);
      if (!this.invertedMapping[channel]) {
        process.stdout.write('Channel not found in config, not joining : ' + channel + os.EOL);
      } else {
        this.ircClient.join(channel);
        process.stdout.write('Joining channel : ' + channel + os.EOL);
      }
    });
  }

  parseText(message) {
    const text = message.mentions.reduce((content, mention) => (
      content.replace(`<@${mention.id}>`, `@${mention.username}`)
    ), message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.get('id', channelId);
        return `#${channel.name}`;
      });
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  sendToIRC(message, isDirectMessage) {
    isDirectMessage = (isDirectMessage == undefined) ? false : true;

    if(isDirectMessage) {
	this.ircClient.say(this.channels[0], message);
	return;
    }

    const author = message.author;
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id) return;

    const channelName = `#${message.channel.name}`;
    const ircChannel = this.channelMapping[channelName];

    process.stdout.write('Channel Mapping : ' + channelName + ' and ' + this.channelMapping[channelName] + os.EOL);
    if (ircChannel) {
      const username = author.username;
      let text = this.parseText(message);
      let displayUsername = username;
      if (this.ircNickColor) {
        const colorIndex = (username.charCodeAt(0) + username.length) % NICK_COLORS.length;
        displayUsername = irc.colors.wrap(NICK_COLORS[colorIndex], username);
      }

      if (this.isCommandMessage(text)) {
	var commands = text.split(' ');

	switch(commands[0]) {
		case this.commandCharacters[0] + 'op' :
			this.ircClient.send('MODE', ircChannel, '+o', commands[1]);
			break;
		case this.commandCharacters[0] + 'deop' :
			this.ircClient.send('MODE', ircChannel, '-o', commands[1]);
			break;
		case this.commandCharacters[0] + 'users' :
			this.ircClient.send('NAMES', ircChannel);
			break;
		default :
			// var cmdMessage = 'COMMANDS : !op <nick>, !deop <nick>, !users';

			// Will going to private message.
			// this.sendToDiscord(this.nickname, this.channels[0], cmdMessage);
			break;
	}
      } else {
        if (text !== '') {
          text = `${displayUsername}: ${text}`;
          this.ircClient.say(ircChannel, text);
        }

        if (message.attachments && message.attachments.length) {
          message.attachments.forEach(a => {
            const urlMessage = `${displayUsername}: ${a.url}`;
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  sendToDiscord(author, channel, text) {
    const discordChannelName = this.invertedMapping[channel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving:
      const discordChannel = this.discord.channels.get('name', discordChannelName.slice(1));

      if (!discordChannel) {
        process.stdout.write('Tried to send a message to a channel the bot isn\'t in : ' +         discordChannelName + os.EOL);
        return;
      }

      const withMentions = text.replace(/@[^\s]+\b/g, match => {
        const user = this.discord.users.get('username', match.substring(1));
        return user ? user.mention() : match;
      });

      if(this.isCommandMessage(text)) {
          var responseText = 'Command not support.';

          switch(text) {
              case this.commandCharacters[0] + 'games' :
                  responseText = 'PLAY LIST : ';
                  var channelUser = this.discord.users;
                  
                  channelUser.forEach(function(user) {
                      if(user.game != null) {
                          responseText += user.username + '[' + user.game.name + '], ';
                      }
                  });
       
                  responseText = responseText.substring(0, responseText.length - 2);

                  break;
              case this.commandCharacters[0] + 'users' :
                  responseText = 'DISCORD IN : ';
                  var channelUser = this.discord.users;
                  var onlineCnt = 0;
                  var offlineCnt = 0;
                  var idleCnt = 0;

                  channelUser.forEach(function(user) {
                     var signTag = 'v';

                     if(user.status == 'online') { 
                         signTag = '^';
                         onlineCnt++;
                     }

                     if(user.status == 'offline') {
                         signTag = 'v';
                         offlineCnt++;
                     }

                     if(user.status == 'idle') {
                         signTag = '-';
                         idleCnt++;
                     }

                     if(user.status == 'online' || user.status == 'idle') {
                         responseText += signTag + user.username + ', '
                     }
                  });

                  responseText = responseText.substring(0, responseText.length - 2)
                  responseText += ' : online ' + onlineCnt + ', offline ' + offlineCnt + ', idle ' + idleCnt + ' = Total ' + channelUser.length 

                  break;
          }

          this.sendToIRC(responseText, true)
          return
      }

      // Add bold formatting:
      const withAuthor = `**${author}:** ${withMentions}`;
      this.discord.sendMessage(discordChannel, withAuthor);
    }
  }
}

export default Bot;
