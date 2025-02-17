import { PollOption, Post } from '@prisma/client';
import { Session } from 'next-auth';
import { z } from 'zod';
import { addDays } from '../../../utils/DateUtils';
import { createPostInput } from '../../../validation/post';
import { t } from '../../trpc';

export const postRouter = t.router({
  /** Retrieves information about a single post (poll). */
  get: t.procedure.input(z.object({ postId: z.string().min(1) })).query(async ({ ctx, input }) => {
    const { postId } = input;
    const userId = ctx.session?.user?.id;

    /** Retrieves all posts for a given topic. */
    const result = await ctx.prisma.post.findUnique({
      where: { id: postId },
      include: {
        PostVote: {
          where: {
            userId: userId ?? '',
          },
        },
        options: {
          include: {
            userVotes: {
              where: { userId: userId ?? '' },
            },
          },
        },
        user: true,
      },
    });

    if (result) {
      filterPost(result, new Date());
    }
    return result;
  }),

  /** Returns the top 100 posts for this topic. */
  getAll: t.procedure
    .input(z.object({ topicId: z.optional(z.string()) }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;

      /** Retrieves all posts for a given topic. */
      const topicId = input.topicId?.toLowerCase() ?? '';

      const result = await ctx.prisma.post.findMany({
        ...(topicId ? { where: { topicId } } : {}),
        include: {
          options: {
            include: {
              userVotes: {
                where: { userId: userId ?? '' },
              },
            },
          },
          PostVote: {
            where: {
              userId: userId ?? '',
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 100,
      });

      // Zero out vote counts for polls that haven't ended yet.
      const now = new Date();
      for (const post of result) {
        filterPost(post, now);
      }

      return result;
    }),

  /** Creates a new post (poll) with options. */
  create: t.procedure.input(createPostInput).mutation(async ({ ctx, input }) => {
    const { title, description, type, options } = input;

    // Create a new Topic if one doesn't already exist, or fail.
    const topicId = input.topicId.toLowerCase();
    await ctx.prisma.topic
      .create({
        data: { id: topicId },
      })
      .catch(() => ({}));

    try {
      const userId = ctx.session?.user?.id;
      const { id } = await ctx.prisma.post.create({
        data: {
          title,
          description,
          type,
          topicId,
          userId,
          endsAt: addDays(7), // End polls 7 days after they're created.

          options: {
            create: options,
          },
        },
        include: {
          options: true,
        },
      });
      return { id, title };
    } catch (e) {
      console.error('Failed to create post.', e);
    }

    throw new Error('Failed to create post.');
  }),

  /** Votes on a poll. */
  voteOption: t.procedure
    .input(
      z.object({
        postId: z.string().min(1),
        pollOptionId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { postId, pollOptionId } = input;
      const userId = assertUserId(ctx);

      // TODO(acorn1010): Implement confidence interval to figure out when poll should end (when
      //  consensus is reached).
      //  @link https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval

      // Verify that post is still going on.
      const post = await ctx.prisma.post.findUnique({ where: { id: postId } });
      if (post && post.endsAt <= new Date()) {
        throw new Error('Poll has ended.');
      }

      try {
        await ctx.prisma.$transaction([
          ctx.prisma.pollOptionVote.create({
            data: { userId, postId, pollOptionId },
          }),
          ctx.prisma.pollOption.update({
            where: { id: pollOptionId },
            data: {
              upvotesCount: { increment: 1 },
            },
          }),
        ]);
      } catch (e) {
        console.error('Failed to vote for option.', { postId, pollOptionId, userId }, e);
        throw new Error('Unable to vote on poll at this time.');
      }
    }),

  /** Votes on a post to move it up in the topic and make it more visible for others. */
  vote: t.procedure
    .input(
      z.object({
        postId: z.string().min(1),
        magnitude: z.number().gte(-1).lte(1).int(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { magnitude, postId } = input;
      // User is voting on a post itself.
      const userId = assertUserId(ctx);

      try {
        // First, handle the removal of any current votes.
        const maybeVote = await ctx.prisma.postVote.findUnique({
          where: { userId_postId: { userId, postId } },
        });
        if (maybeVote) {
          // There was an old vote. Remove it!
          const oldMagnitude = maybeVote.magnitude;
          await ctx.prisma.$transaction([
            ctx.prisma.postVote.delete({
              where: { userId_postId: { userId, postId } },
            }),
            ctx.prisma.post.update({
              where: { id: postId },
              data: {
                totalCount: { decrement: oldMagnitude },
                [oldMagnitude >= 0 ? 'upvotesCount' : 'downvotesCount']: {
                  decrement: 1,
                },
              },
            }),
          ]);

          // User had an old vote, so just remove their vote and return.
          if (oldMagnitude === magnitude) {
            return;
          }
        }

        // If the user wants to remove their vote without any new vote, do that.
        if (!magnitude) {
          return;
        }

        // Add the new vote
        await ctx.prisma.$transaction([
          ctx.prisma.postVote.create({
            data: { userId, postId, magnitude },
          }),
          ctx.prisma.post.update({
            where: { id: postId },
            data: {
              totalCount: { increment: magnitude },
              [magnitude >= 0 ? 'upvotesCount' : 'downvotesCount']: {
                increment: 1,
              },
            },
          }),
        ]);
      } catch (e) {
        console.error(e);
      }
    }),
});

/** Returns the session's userId, else throws an exception. */
function assertUserId(ctx: { session: Session | null }) {
  const userId = ctx.session?.user?.id;
  if (!userId) {
    throw new Error('You must be signed in to vote.');
  }
  return userId;
}

/** Filters out information from a post before returning it to the client. */
function filterPost(post: Post & { options: PollOption[] }, now: Date) {
  if (post.endsAt <= now) {
    return;
  }
  for (const option of post.options) {
    option.downvotesCount = 0;
    option.totalCount = 0;
    option.upvotesCount = 0;
  }
  return post;
}
